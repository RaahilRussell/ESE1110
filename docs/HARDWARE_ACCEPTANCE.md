# Physical acceptance record

Software test results do not establish that a physical light responded. No real fixture or physical iPhone acceptance result has been recorded in this repository.

Before enabling unattended output, record the controller host, output node model and firmware, fixture inventory and exact operating modes, cable topology and termination, and the lab-approved power isolation procedure.

Run the same scene and cue scenarios used in automated tests through a real node:

1. Verify each light individually: correct name, address, mode, primary colors and safe identify pattern. Confirm the response by observation.
2. Change only one light, then one group. Confirm unrelated lights hold their values.
3. Set grand master to zero. Confirm every intensity channel, including amber and UV, is dark.
4. Engage blackout during a fade, cue and identify. Confirm safe darkness and no fixture reset or automatic program.
5. Disconnect and reconnect the phone during a fade. Output must continue; the phone must resynchronize.
6. Restart the controller. Configuration survives; Show and Music never automatically restart.
7. Disconnect the output node. A successful UDP send must never be interpreted as proof that a fixture received it. Confirm the receiver's documented data-loss behavior.
8. From a physical iPhone on the local network, discover or enter the host, authenticate, activate a look, save a scene and run a cue.
9. Run the rehearsal/soak for eight hours and retain timing, frame gaps, memory and restart evidence.

Record pass/fail, observed behavior, equipment and date for each check. Software blackout supplements the physical isolation process; it cannot remove fixture power.
