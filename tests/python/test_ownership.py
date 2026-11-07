import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from packages.actuation.gamepad_backend import AnalogController, MockPad
from packages.actuation.input_ownership import BridgeOwner, InputFileGuard
from packages.actuation.xinput_readback import initialize_neutral


class BackendOwnership(unittest.TestCase):
    def setup_controller(self):
        self.now = 0.
        self.pad = MockPad()
        parent = self

        class Owner:
            owner_id = 'test-only'
            valid = True
            released = False
            generation = 7
            def check(self, duration_ms=None, source=None):
                if not self.valid:
                    raise RuntimeError('revoked or disconnected')
                return dict(remaining_ms=250 if duration_ms is None else duration_ms)
            def reserve(self):
                raise AssertionError('No implicit reacquisition')
            def release_neutral(self):
                parent.assertEqual(parent.pad.calls[-2:], [('reset', {}), ('update', {})])
                self.released = True
                self.owner_id = None

        self.owner = Owner()
        return AnalogController(self.pad, clock=lambda: self.now, owner=self.owner)

    def test_revoke_neutralizes_without_parent_and_command_cannot_rearm(self):
        c = self.setup_controller()
        c.arm()
        command = dict(steer=.4, throttle=.2, brake=0., duration_ms=250)
        c.set(command, dict(sequence=1,generation=7,capture_start_ms=1000,decision_expires_ms=1250))
        self.now = .02
        c.tick()
        self.assertGreater(c.values['throttle'], 0)
        self.owner.valid = False
        self.now = .04
        c.tick()
        self.assertFalse(c.active)
        self.assertEqual(c.fault, 'ownership_revoked')
        self.assertEqual(c.values, dict(steer=0., throttle=0., brake=0.))
        self.assertTrue(self.owner.released)
        before = len(self.pad.calls)
        with self.assertRaises(ValueError):
            c.set(command, dict(sequence=1,generation=7,capture_start_ms=1000,decision_expires_ms=1250))
        self.assertEqual(len(self.pad.calls), before)

    def test_waiting_reservation_is_released_after_broker_revocation(self):
        c = self.setup_controller()
        self.owner.valid = False
        c.tick()
        self.assertTrue(self.owner.released)
        self.assertFalse(c.active)

    def test_slow_permission_check_cannot_extend_expired_local_command(self):
        c = self.setup_controller()
        c.arm()
        self.owner.check = lambda duration=None,source=None: setattr(self, 'now', .3)
        with self.assertRaisesRegex(ValueError, 'expired during'):
            c.set(dict(steer=.4, throttle=.2, brake=0., duration_ms=250), dict(sequence=1,generation=7,capture_start_ms=1000,decision_expires_ms=1250))
        self.assertFalse(c.active)
        self.assertTrue(self.owner.released)

    def test_tick_rechecks_local_expiry_after_broker_response(self):
        c = self.setup_controller()
        c.arm()
        c.set(dict(steer=.4, throttle=.2, brake=0., duration_ms=250), dict(sequence=1,generation=7,capture_start_ms=1000,decision_expires_ms=1250))
        self.owner.check = lambda duration=None,source=None: setattr(self, 'now', .3)
        c.tick()
        self.assertFalse(c.active)
        self.assertFalse(any(name == 'gas' for name, _ in self.pad.calls))

    def test_failed_neutral_does_not_acknowledge_release(self):
        c = self.setup_controller()
        c.arm()
        def fail():
            raise RuntimeError('driver reset failed')
        self.pad.reset = fail
        with self.assertRaises(RuntimeError):
            c.stop()
        self.assertFalse(self.owner.released)

    def test_initialization_cannot_prime_stick_after_permission_was_revoked(self):
        pad = MockPad()
        def denied():
            raise RuntimeError('revoked')
        with self.assertRaisesRegex(RuntimeError, 'revoked'):
            initialize_neutral(pad, slot=0, read=lambda _: dict(error=0, values=dict(left_x=1)), sleep=lambda _: None, permission=denied)
        self.assertTrue(all(name in ('reset', 'update') for name, _ in pad.calls))


class BrokerProtocol(unittest.TestCase):
    def test_backend_polls_without_renewing_and_releases_only_its_capability(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.respond()
            def do_POST(self):
                self.respond()
            def respond(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                payload = json.loads(body) if body else None
                requests.append((self.path, payload, self.headers.get('Authorization')))
                result = dict(ownership_supported=True, decision_deadline_supported=True, generation=7) if self.path == '/status' else dict(owner_id='capability', generation=7, remaining_ms=250)
                data = json.dumps(result).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        class Guard:
            closed = False
            def close(self):
                self.closed = True
        guard = Guard()
        try:
            with tempfile.TemporaryDirectory() as folder:
                config = Path(folder) / 'connection.json'
                config.write_text(json.dumps(dict(url='http://127.0.0.1:'+str(server.server_port), token='unit-test-only')))
                owner = BridgeOwner(config, 123, guard_factory=lambda: guard)
                owner.reserve()
                source=dict(sequence=1,generation=7,capture_start_ms=1000,decision_expires_ms=1200)
                owner.check(200,source)
                owner.check()
                owner.release_neutral()
                self.assertTrue(guard.closed)
                self.assertIsNone(owner.owner_id)
                self.assertEqual(requests[2][1], dict(owner_id='capability', generation=7, duration_ms=200, source=source))
                self.assertEqual(requests[3][1], dict(owner_id='capability', generation=7))
                self.assertEqual(requests[4][1], dict(owner_id='capability'))
                self.assertTrue(all(auth == 'Bearer unit-test-only' for _, _, auth in requests))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_old_or_disconnected_bridge_does_not_leave_local_lock(self):
        class Guard:
            closed = False
            def close(self):
                self.closed = True
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'connection.json'
            config.write_text(json.dumps(dict(url='http://127.0.0.1:1', token='unit-test-only')))
            guard = Guard()
            owner = BridgeOwner(config, 123, guard_factory=lambda: guard)
            owner.request = lambda *_: {}
            with self.assertRaisesRegex(RuntimeError, 'Ownership-aware'):
                owner.reserve()
            self.assertTrue(guard.closed)

    def test_remote_connection_is_rejected_before_lock_or_request(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'connection.json'
            config.write_text(json.dumps(dict(url='http://example.com:80', token='unit-test-only')))
            with self.assertRaises(ValueError):
                BridgeOwner(config, 123)


@unittest.skipUnless(os.name == 'nt', 'Windows share-mode interop')
class ProcessGuard(unittest.TestCase):
    def test_python_guard_blocks_csharp_file_open_and_release_allows_it(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'owner.lock'
            env = dict(os.environ, GTA_TEST_GUARD=str(path))
            script = "try {$f=[IO.File]::Open($env:GTA_TEST_GUARD,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$f.Dispose();exit 0} catch {exit 2}"
            def run():
                return subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], env=env, capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW).returncode
            guard = InputFileGuard(path)
            try:
                self.assertEqual(run(), 2)
            finally:
                guard.close()
            self.assertEqual(run(), 0)

    def test_csharp_owner_blocks_python_until_its_process_exits(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'owner.lock'
            env = dict(os.environ, GTA_TEST_GUARD=str(path))
            script = "$f=[IO.File]::Open($env:GTA_TEST_GUARD,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);[Console]::WriteLine('locked');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null;$f.Dispose()"
            child = subprocess.Popen(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'locked')
                with self.assertRaisesRegex(RuntimeError, 'Another process'):
                    InputFileGuard(path)
                child.kill()
                child.wait(timeout=5)
                guard = InputFileGuard(path)
                guard.close()
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
