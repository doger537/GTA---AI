"""Independent backend permission checks; no device or connection at import time."""
import ctypes
import http.client
import json
from pathlib import Path
from urllib.parse import urlsplit


class InputFileGuard:
    """Windows share-mode lock survives broker restarts; OS closes it on exit."""
    def __init__(self, path=None):
        from ctypes import wintypes
        if path is None:
            folder = ctypes.create_unicode_buffer(32768)
            if ctypes.windll.shell32.SHGetFolderPathW(None, 28, None, 0, folder):
                raise RuntimeError('Cannot resolve input lock directory')
            path = Path(folder.value) / 'GTA-AI' / 'input-owner.lock'
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        self.kernel.CreateFileW.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.kernel.CreateFileW(str(path), 0xC0000000, 0, None, 4, 0x80, None)
        if self.handle == ctypes.c_void_p(-1).value:
            self.handle = None
            raise RuntimeError('Another process owns game input')

    def close(self):
        if self.handle is not None:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class BridgeOwner:
    def __init__(self, connection_file, target_pid, guard_factory=InputFileGuard):
        config = json.loads(Path(connection_file).read_text(encoding='utf-8-sig'))
        url = urlsplit(config['url'])
        if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password or url.path not in ('', '/') or not url.port:
            raise ValueError('Expected local GTA Control URL')
        self.host, self.port, self.auth = url.hostname, url.port, config['token']
        self.pid, self.guard_factory = target_pid, guard_factory
        self.guard = None
        self.owner_id = None
        self.generation = None

    def request(self, path, payload=None):
        connection = http.client.HTTPConnection(self.host, self.port, timeout=.1)
        try:
            body = None if payload is None else json.dumps(payload).encode()
            connection.request('GET' if body is None else 'POST', path, body, {'Authorization': 'Bearer '+self.auth, 'Content-Type': 'application/json', 'Connection': 'close'})
            response = connection.getresponse()
            data = response.read(16385)
            if response.status != 200 or len(data) > 16384:
                raise RuntimeError('Input ownership rejected by bridge')
            return json.loads(data)
        finally:
            connection.close()

    def reserve(self):
        if self.guard is not None:
            raise RuntimeError('Input owner already reserved')
        self.guard = self.guard_factory()
        try:
            status = self.request('/status')
            if not status.get('ownership_supported') or not status.get('decision_deadline_supported'):
                raise RuntimeError('Ownership-aware source-deadline bridge required')
            grant = self.request('/control/arm', dict(kind='gamepad', generation=status['generation'], target_pid=self.pid))
            self.owner_id, self.generation = grant['owner_id'], grant['generation']
        except Exception:
            self.guard.close()
            self.guard = None
            raise

    def check(self, duration_ms=None, source=None):
        if self.owner_id is None or self.guard is None:
            raise RuntimeError('Explicit input arm required')
        payload = dict(owner_id=self.owner_id, generation=self.generation)
        if duration_ms is not None:
            payload['duration_ms'] = duration_ms
            if source is None:raise ValueError('Decision source required for gamepad command')
            payload['source'] = source
        return self.request('/control/check', payload)

    def release_neutral(self):
        # Call ONLY after pad.reset/update succeeded, or when no pad was created.
        try:
            if self.owner_id is not None:
                self.request('/control/release', dict(owner_id=self.owner_id))
        finally:
            self.owner_id = None
            if self.guard is not None:
                self.guard.close()
                self.guard = None
