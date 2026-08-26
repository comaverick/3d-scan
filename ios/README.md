# BuildWise SmartScan iOS scanner

This is the native scanner core for the SmartScan proof of feasibility. It uses `ARWorldTrackingConfiguration` and the RGB camera only. It deliberately does not enable LiDAR-only scene reconstruction, so the movement guidance works on ordinary ARKit-compatible iPhones.

## Run it

1. On a Mac, install Xcode 15 or newer.
2. Open `ios/BuildWiseSmartScan.xcodeproj`.
3. Set your Apple development team under the target's Signing & Capabilities settings.
4. Select a physical iPhone. ARKit world tracking is not available in the iOS Simulator.
5. Build and run, then tap **Start Scan** and grant camera permission.

## Automatic guidance behavior

- The first normally tracked AR frame becomes the origin.
- **Move forward** advances after 0.9 m in the phone's initial forward direction.
- **Turn right** advances after approximately 80 degrees of rotation.
- Wall-scan steps advance after six useful frames, captured after 15 cm or 10 degrees of change.
- **Move left** advances after 0.65 m in the initial left direction.
- **Return to start** advances when the camera is within 0.25 m of the origin.

When the loop closes, tap **Finish Scan** to open the review card. Each useful frame is written as a JPEG under the app's `Documents/ScanSessions/<session-id>/` directory, alongside a versioned `manifest.json` containing the ARKit world-space origin, frame poses, timestamps, yaw, coverage, and scan duration. The review card can share the manifest and captured images through the iOS share sheet. Files are also exposed through the Files app because document sharing is enabled.

ARKit gives reliable relative movement and heading, but room dimensions and final geometry still need the backend reconstruction phase. This target is the guided scanner and capture handoff, not the final mesh generator.
