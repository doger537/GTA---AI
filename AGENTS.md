# GTA project continuity

Read `PROJECT-STATE.md` before continuing implementation. Code and deliverables live in `outputs/GtaAutopilot/` and `outputs/GtaControl/`.
`PROJECT-STATE.md` is private local continuity data and is not published. In a fresh clone read `CURRENT-STATUS.md` instead.

Read `DEVELOPMENT-PLAN.md` for the user's detailed future roadmap, dependencies, measurement protocols and proposed acceptance criteria. Its unchecked plans and numerical targets are not completed results or authorization to skip observation/verification.

- The user wants screen-based GTA Online control with smooth analog driving and eventual destination commands. Existing recordings are free driving, without GPS intent labels.
- Preserve recordings, trained weights and experiment reports. Keep intermediate files in `work/`; never invent steering angles, navigation labels or successful driving results.
- Keep perception thresholds, pixel processing, model weights and actuator leases unchanged during performance-only optimization. Compare outputs against saved baselines.
- JavaScript checks: `npm test` in `outputs/GtaAutopilot`. Python: `training-env/Scripts/python.exe -m unittest test_ablation.py test_integration.py`. C# changes require a Windows PowerShell build and `--self-test REPORT_PATH` before deployment.
- No game input is required for code optimization. For authorized live tests, keep F8/focus/lease stops effective and verify the current frame and initial state. A neutral controller does not guarantee a stopped vehicle.
- Connection tokens in `outputs/GtaControl/connection.json` are private. Never print them.
