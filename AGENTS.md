# GTA project continuity

Read `PROJECT-STATE.md` before continuing implementation. Canonical code lives in `apps/gta-control/`, `packages/` and `training/`; offline tools and reports live in `experiments/tools/` and `docs/reports/`. Read `docs/ARCHITECTURE.md`. The old `outputs/GtaAutopilot/` and `outputs/GtaControl/` are compatibility entry points, not implementation directories.
`PROJECT-STATE.md` is private local continuity data and is not published. In a fresh clone read `CURRENT-STATUS.md` instead.

Read `DEVELOPMENT-PLAN.md` for the user's detailed future roadmap, dependencies, measurement protocols and proposed acceptance criteria. Its unchecked plans and numerical targets are not completed results or authorization to skip observation/verification.

- The user wants screen-based GTA Online control with smooth analog driving and eventual destination commands. Existing recordings are free driving, without GPS intent labels.
- Preserve recordings, trained weights and experiment reports. Keep intermediate files in `work/`; never invent steering angles, navigation labels or successful driving results.
- Keep perception thresholds, pixel processing, model weights and actuator leases unchanged during performance-only optimization. Compare outputs against saved baselines.
- Run JavaScript checks from the repository root: `npm test` (full local assets) or `npm run test:core` (included fixtures). Python: `npm run test:python`. C# changes require a Windows PowerShell build (`apps/gta-control/Build.ps1`) and `--self-test REPORT_PATH` before deployment.
- No game input is required for code optimization. For authorized live tests, keep F8/focus/lease stops effective and verify the current frame and initial state. A neutral controller does not guarantee a stopped vehicle.
- Input ownership: all keyboard commands require explicit arm, owner_id and generation; real Python gamepad must use BridgeOwner plus the shared Windows input file guard. Never bypass those guards or clear a pending gamepad owner before a successful neutral acknowledgement. See `docs/reports/INPUT-OWNERSHIP-RESULT.md`.
- Real Python commands also require the immutable `source` envelope from DecisionLease.wireSource(). Validate its absolute capture-clock deadline through the broker; do not replace it with a fresh TTL on receipt or compare timestamps across clock domains. See `docs/reports/DECISION-DEADLINE-RESULT.md`.
- Connection tokens in `apps/gta-control/connection.json` and the legacy `outputs/GtaControl/connection.json` are private. Never print them.
- Local asset directories may be junctions to `D:/GTA-AI-data/`. Never recursively delete/move a junction or its target. Keep model hashes in `models-manifest.json`; verify using `npm run models:verify`.
