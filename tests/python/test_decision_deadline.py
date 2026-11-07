"""Synthetic clocks and MockPad only; broker policy itself is tested in C#."""
import unittest

from packages.actuation.gamepad_backend import AnalogController, MockPad


class SourceDeadline(unittest.TestCase):
    def setup_controller(self, remaining=50, request_delay=0):
        self.now = 0.
        self.pad = MockPad()
        self.calls = []
        parent = self
        class Owner:
            generation = 7
            owner_id = 'unit-test-only'
            def check(self, duration_ms=None, source=None):
                parent.calls.append((duration_ms, source))
                if duration_ms is not None:
                    parent.now += request_delay
                    return dict(remaining_ms=remaining)
                return dict(remaining_ms=250)
            def release_neutral(self):
                self.owner_id = None
            def reserve(self):
                raise AssertionError('No automatic re-arm')
        self.owner = Owner()
        self.controller = AnalogController(self.pad, clock=lambda: self.now, owner=self.owner)
        self.controller.arm()
        return self.controller

    def command(self):
        return dict(steer=.4, throttle=.2, brake=0., duration_ms=250)

    def source(self, **overrides):
        return dict(sequence=1, generation=7, capture_start_ms=1000, decision_expires_ms=1350) | overrides

    def test_broker_remaining_fifty_ms_does_not_become_fresh_250ms(self):
        c = self.setup_controller(remaining=50)
        c.set(self.command(), self.source())
        self.assertAlmostEqual(c.deadline, .05)
        self.now = .02
        c.tick()
        self.assertGreater(c.values['throttle'], 0)
        self.now = .051
        c.tick()
        self.assertFalse(c.active)
        self.assertEqual(c.values, dict(steer=0., throttle=0., brake=0.))
        with self.assertRaises(ValueError):
            c.set(self.command(), self.source())

    def test_network_wait_is_subtracted_before_any_axis_write(self):
        c = self.setup_controller(remaining=30, request_delay=.04)
        with self.assertRaisesRegex(ValueError, 'before application'):
            c.set(self.command(), self.source())
        self.assertFalse(c.active)
        self.assertFalse(any(name in ('steer', 'gas', 'brake') for name, _ in self.pad.calls))

    def test_duplicate_cannot_extend_even_if_broker_reports_a_larger_remaining(self):
        c = self.setup_controller(remaining=100)
        c.set(self.command(), self.source())
        first = c.deadline
        self.now = .04
        c.set(self.command(), self.source())
        self.assertEqual(c.deadline, first)
        self.now = .101
        c.tick()
        self.assertFalse(c.active)

    def test_shortened_claim_and_fresh_later_capture_have_distinct_deadlines(self):
        c = self.setup_controller(remaining=100)
        c.set(self.command(), self.source())
        self.now = .02
        c.set(self.command(), self.source(decision_expires_ms=1340))
        self.assertEqual(c.deadline, .1)
        self.now = .04
        c.set(self.command(), self.source(sequence=2, capture_start_ms=1050, decision_expires_ms=1400))
        self.assertAlmostEqual(c.deadline, .14)

    def test_missing_malformed_regressed_changed_and_extended_sources_fail_closed(self):
        bad = [None, {}, self.source(sequence=True), self.source(generation=8), self.source(sequence=0),
               self.source(capture_start_ms=1001), self.source(decision_expires_ms=1351),
               self.source(sequence=2, capture_start_ms=999), self.source(decision_expires_ms=float('nan')),
               self.source(decision_expires_ms=1451), self.source(extra=1)]
        for source in bad:
            with self.subTest(source=source):
                c = self.setup_controller(remaining=100)
                c.set(self.command(), self.source())
                with self.assertRaises(ValueError):
                    c.set(self.command(), source)
                self.assertFalse(c.active)
                self.assertIsNone(self.owner.owner_id)

    def test_broker_rejects_queued_decision_and_no_command_is_applied(self):
        c = self.setup_controller()
        def expired(duration_ms=None, source=None):
            raise RuntimeError('Decision expired in capture clock')
        self.owner.check = expired
        # The stdin protocol closes the session on this error.
        with self.assertRaises(RuntimeError):
            c.set(self.command(), self.source())
        self.assertIsNone(c.command)
        c.stop('invalid_request')
        self.assertIsNone(self.owner.owner_id)
        self.assertFalse(any(name in ('steer', 'gas', 'brake') for name, _ in self.pad.calls))

    def test_invalid_remaining_response_cannot_authorize_output(self):
        for remaining in [None, True, -1, 0, 251, float('inf'), float('nan')]:
            with self.subTest(remaining=remaining):
                c = self.setup_controller(remaining=remaining)
                with self.assertRaises(ValueError):
                    c.set(self.command(), self.source())
                self.assertFalse(c.active)

    def test_real_pad_without_authority_is_not_an_offline_mock(self):
        with self.assertRaisesRegex(ValueError, 'Real pad requires'):
            AnalogController(object())

    def test_focus_or_f8_change_during_permission_wait_prevents_axis_writes(self):
        c = self.setup_controller(remaining=100)
        focused = [True]
        c.safety = lambda: focused[0]
        c.set(self.command(), self.source())
        def check(duration_ms=None, source=None):
            focused[0] = False
            return dict(remaining_ms=100)
        self.owner.check = check
        self.now = .02
        c.tick()
        self.assertFalse(c.active)
        self.assertEqual(c.fault, 'focus_lost_or_f8')
        self.assertFalse(any(name in ('steer', 'gas', 'brake') for name, _ in self.pad.calls))


if __name__ == '__main__':
    unittest.main()
