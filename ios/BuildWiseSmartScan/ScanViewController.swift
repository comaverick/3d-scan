import ARKit
import CoreImage
import SceneKit
import UIKit
import Vision

private enum ScanStep {
    case ready
    case moveForward
    case turnRight
    case scanWall
    case moveLeft
    case scanOpposite
    case returnToStart
    case complete

    var title: String {
        switch self {
        case .ready: return "Choose a clear starting view"
        case .moveForward: return "Move into the open space"
        case .turnRight: return "Turn toward the next surface"
        case .scanWall: return "Sweep the next visible surface"
        case .moveLeft: return "Follow the room edge"
        case .scanOpposite: return "Sweep the far side"
        case .returnToStart: return "Close the loop at your starting view"
        case .complete: return "Room mesh is ready to review"
        }
    }

    var instruction: String {
        switch self {
        case .ready: return "Hold your phone chest-high and aim at a clear wall or corner."
        case .moveForward: return "Walk a few steady steps into the open space. Keep the floor line in view."
        case .turnRight: return "Keep your feet planted and rotate until the next wall or corner is centered."
        case .scanWall: return "Pan across the visible surface slowly. Keep part of the previous view overlapped."
        case .moveLeft: return "Take a few slow steps along the room edge and aim for the next corner."
        case .scanOpposite: return "Sweep the far side and include corners, windows, and doors."
        case .returnToStart: return "Walk back to the starting view and face the original direction."
        case .complete: return "Review the captured mesh, classified surfaces, and furniture observations."
        }
    }

    var target: String {
        switch self {
        case .ready: return "Reference view"
        case .moveForward: return "Steady movement"
        case .turnRight: return "Overlapping turn"
        case .scanWall: return "Overlapping views"
        case .moveLeft: return "Room edge"
        case .scanOpposite: return "Far-side views"
        case .returnToStart: return "Close the loop"
        case .complete: return "Ready to review"
        }
    }

    var coverage: Float {
        switch self {
        case .ready: return 0
        case .moveForward: return 16
        case .turnRight: return 28
        case .scanWall: return 47
        case .moveLeft: return 61
        case .scanOpposite: return 78
        case .returnToStart: return 91
        case .complete: return 94
        }
    }
}

private struct CapturedFrame {
    let id: Int
    let timestamp: TimeInterval
    let position: SIMD3<Float>
    let yaw: Float
    let imageFileName: String?
}

private struct ExportedFrame: Codable {
    let id: Int
    let timestamp: TimeInterval
    let x: Float
    let y: Float
    let z: Float
    let yaw: Float
    let imageFileName: String?
}

private struct DetectedObject: Codable {
    let label: String
    let confidence: Float
    let x: Float
    let y: Float
    let z: Float
    let frameID: Int
    let source: String
}

private struct ScanSessionManifest: Codable {
    let schemaVersion: Int
    let sessionID: String
    let coordinateSystem: String
    let origin: [Float]?
    let createdAt: Date
    let durationSeconds: TimeInterval
    let coveragePercent: Int
    let frameCount: Int
    let frames: [ExportedFrame]
    let meshPLY: String?
    let surfaceSummary: [String: Int]
    let detectedObjects: [DetectedObject]
}

final class ScanViewController: UIViewController, ARSessionDelegate, ARSCNViewDelegate {
    private let sceneView = ARSCNView(frame: .zero)
    private let topBar = UIView()
    private let instructionCard = UIView()
    private let brandLabel = UILabel()
    private let trackingLabel = UILabel()
    private let instructionStepLabel = UILabel()
    private let instructionTitleLabel = UILabel()
    private let instructionDetailLabel = UILabel()
    private let targetLabel = UILabel()
    private let telemetryLabel = UILabel()
    private let coverageLabel = UILabel()
    private let coverageProgress = UIProgressView(progressViewStyle: .default)
    private let startButton = UIButton(type: .system)
    private let finishButton = UIButton(type: .system)
    private let reticle = UIView()
    private let reviewCard = UIView()
    private let reviewStepLabel = UILabel()
    private let reviewTitleLabel = UILabel()
    private let reviewDetailLabel = UILabel()
    private let reviewMetricsLabel = UILabel()
    private let shareButton = UIButton(type: .system)
    private let scanAgainButton = UIButton(type: .system)

    private var currentStep: ScanStep = .ready
    private var isScanning = false
    private var originTransform: simd_float4x4?
    private var instructionStartPosition: SIMD3<Float>?
    private var instructionStartYaw: Float?
    private var lastCapturedPosition: SIMD3<Float>?
    private var lastCapturedYaw: Float?
    private var stepStartFrameCount = 0
    private var stepStartTime: TimeInterval = 0
    private var capturedFrames: [CapturedFrame] = []
    private var sessionID: String?
    private var sessionDirectoryURL: URL?
    private var sessionStartedAt: Date?
    private var manifestURL: URL?
    private let imageContext = CIContext()
    private var meshAnchors: [UUID: ARMeshAnchor] = [:]
    private var detectedObjects: [DetectedObject] = []
    private var visionRequestInFlight = false
    private var hasSceneReconstruction = false
    private var hasSceneClassification = false
    private let visionQueue = DispatchQueue(label: "com.buildwise.smartscan.vision", qos: .userInitiated)

    override func viewDidLoad() {
        super.viewDidLoad()
        configureSceneView()
        configureOverlay()
        updateInterface()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard ARWorldTrackingConfiguration.isSupported else {
            trackingLabel.text = "AR WORLD TRACKING NOT SUPPORTED"
            startButton.isEnabled = false
            return
        }
        trackingLabel.text = ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification)
            ? "AR TRACKING + ROOM MESH READY"
            : ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
                ? "AR TRACKING + ROOM MESH READY"
                : "AR WORLD TRACKING READY"
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sceneView.session.pause()
    }

    private func configureSceneView() {
        sceneView.translatesAutoresizingMaskIntoConstraints = false
        sceneView.automaticallyUpdatesLighting = true
        sceneView.session.delegate = self
        sceneView.delegate = self
        sceneView.contentMode = .scaleAspectFill
        sceneView.showsStatistics = false
        view.addSubview(sceneView)
        NSLayoutConstraint.activate([
            sceneView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            sceneView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            sceneView.topAnchor.constraint(equalTo: view.topAnchor),
            sceneView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        reticle.translatesAutoresizingMaskIntoConstraints = false
        reticle.layer.borderColor = UIColor(red: 1.0, green: 0.76, blue: 0.48, alpha: 0.9).cgColor
        reticle.layer.borderWidth = 1
        view.addSubview(reticle)
        NSLayoutConstraint.activate([
            reticle.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            reticle.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -48),
            reticle.widthAnchor.constraint(equalToConstant: 84),
            reticle.heightAnchor.constraint(equalToConstant: 84)
        ])
    }

    private func configureOverlay() {
        view.backgroundColor = .black
        [topBar, instructionCard, reviewCard].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            $0.backgroundColor = UIColor(white: 0.05, alpha: 0.82)
            $0.layer.cornerRadius = 14
            view.addSubview($0)
        }
        reviewCard.isHidden = true

        brandLabel.text = "BUILDWISE / SMARTSCAN"
        brandLabel.textColor = .white
        brandLabel.font = UIFont.monospacedSystemFont(ofSize: 12, weight: .bold)

        trackingLabel.textColor = UIColor(red: 0.59, green: 0.85, blue: 0.7, alpha: 1)
        trackingLabel.font = UIFont.monospacedSystemFont(ofSize: 10, weight: .medium)
        trackingLabel.textAlignment = .right

        [brandLabel, trackingLabel].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            topBar.addSubview($0)
        }

        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            topBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            topBar.heightAnchor.constraint(equalToConstant: 48),
            brandLabel.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 14),
            brandLabel.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            trackingLabel.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -14),
            trackingLabel.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            trackingLabel.leadingAnchor.constraint(greaterThanOrEqualTo: brandLabel.trailingAnchor, constant: 12)
        ])

        instructionCard.addSubview(instructionStepLabel)
        instructionCard.addSubview(instructionTitleLabel)
        instructionCard.addSubview(instructionDetailLabel)
        instructionCard.addSubview(targetLabel)
        instructionCard.addSubview(coverageLabel)
        instructionCard.addSubview(coverageProgress)
        instructionCard.addSubview(telemetryLabel)
        instructionCard.addSubview(startButton)
        instructionCard.addSubview(finishButton)

        [instructionStepLabel, instructionTitleLabel, instructionDetailLabel, targetLabel, coverageLabel, telemetryLabel].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
        }
        coverageProgress.translatesAutoresizingMaskIntoConstraints = false
        startButton.translatesAutoresizingMaskIntoConstraints = false
        finishButton.translatesAutoresizingMaskIntoConstraints = false

        instructionStepLabel.font = UIFont.monospacedSystemFont(ofSize: 10, weight: .medium)
        instructionStepLabel.textColor = UIColor(red: 1.0, green: 0.76, blue: 0.48, alpha: 1)
        instructionTitleLabel.font = UIFont.systemFont(ofSize: 24, weight: .semibold)
        instructionTitleLabel.textColor = .white
        instructionTitleLabel.numberOfLines = 2
        instructionDetailLabel.font = UIFont.systemFont(ofSize: 14, weight: .regular)
        instructionDetailLabel.textColor = UIColor(white: 0.78, alpha: 1)
        instructionDetailLabel.numberOfLines = 0
        targetLabel.font = UIFont.monospacedSystemFont(ofSize: 12, weight: .medium)
        targetLabel.textColor = UIColor(red: 1.0, green: 0.76, blue: 0.48, alpha: 1)
        coverageLabel.font = UIFont.monospacedSystemFont(ofSize: 12, weight: .medium)
        coverageLabel.textColor = UIColor(white: 0.76, alpha: 1)
        telemetryLabel.font = UIFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        telemetryLabel.textColor = UIColor(white: 0.64, alpha: 1)
        telemetryLabel.numberOfLines = 2
        coverageProgress.progressTintColor = UIColor(red: 1.0, green: 0.66, blue: 0.35, alpha: 1)
        coverageProgress.trackTintColor = UIColor(white: 1, alpha: 0.16)

        configureButton(startButton, title: "START SCAN", filled: true)
        configureButton(finishButton, title: "FINISH SCAN", filled: false)
        startButton.addTarget(self, action: #selector(startScan), for: .touchUpInside)
        finishButton.addTarget(self, action: #selector(finishScan), for: .touchUpInside)

        NSLayoutConstraint.activate([
            instructionCard.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            instructionCard.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            instructionCard.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            instructionStepLabel.topAnchor.constraint(equalTo: instructionCard.topAnchor, constant: 18),
            instructionStepLabel.leadingAnchor.constraint(equalTo: instructionCard.leadingAnchor, constant: 18),
            instructionTitleLabel.topAnchor.constraint(equalTo: instructionStepLabel.bottomAnchor, constant: 8),
            instructionTitleLabel.leadingAnchor.constraint(equalTo: instructionCard.leadingAnchor, constant: 18),
            instructionTitleLabel.trailingAnchor.constraint(equalTo: instructionCard.trailingAnchor, constant: -18),
            instructionDetailLabel.topAnchor.constraint(equalTo: instructionTitleLabel.bottomAnchor, constant: 8),
            instructionDetailLabel.leadingAnchor.constraint(equalTo: instructionCard.leadingAnchor, constant: 18),
            instructionDetailLabel.trailingAnchor.constraint(equalTo: instructionCard.trailingAnchor, constant: -18),
            targetLabel.topAnchor.constraint(equalTo: instructionDetailLabel.bottomAnchor, constant: 16),
            targetLabel.leadingAnchor.constraint(equalTo: instructionCard.leadingAnchor, constant: 18),
            coverageLabel.centerYAnchor.constraint(equalTo: targetLabel.centerYAnchor),
            coverageLabel.trailingAnchor.constraint(equalTo: instructionCard.trailingAnchor, constant: -18),
            coverageProgress.topAnchor.constraint(equalTo: targetLabel.bottomAnchor, constant: 8),
            coverageProgress.leadingAnchor.constraint(equalTo: instructionCard.leadingAnchor, constant: 18),
            coverageProgress.trailingAnchor.constraint(equalTo: instructionCard.trailingAnchor, constant: -18),
            telemetryLabel.topAnchor.constraint(equalTo: coverageProgress.bottomAnchor, constant: 12),
            telemetryLabel.leadingAnchor.constraint(equalTo: instructionCard.leadingAnchor, constant: 18),
            telemetryLabel.trailingAnchor.constraint(equalTo: instructionCard.trailingAnchor, constant: -18),
            startButton.topAnchor.constraint(equalTo: telemetryLabel.bottomAnchor, constant: 14),
            startButton.leadingAnchor.constraint(equalTo: instructionCard.leadingAnchor, constant: 18),
            startButton.trailingAnchor.constraint(equalTo: finishButton.leadingAnchor, constant: -10),
            startButton.bottomAnchor.constraint(equalTo: instructionCard.bottomAnchor, constant: -18),
            startButton.heightAnchor.constraint(equalToConstant: 44),
            finishButton.topAnchor.constraint(equalTo: telemetryLabel.bottomAnchor, constant: 14),
            finishButton.trailingAnchor.constraint(equalTo: instructionCard.trailingAnchor, constant: -18),
            finishButton.bottomAnchor.constraint(equalTo: instructionCard.bottomAnchor, constant: -18),
            finishButton.heightAnchor.constraint(equalToConstant: 44),
            finishButton.widthAnchor.constraint(equalTo: startButton.widthAnchor)
        ])

        configureReviewCard()
    }

    private func configureReviewCard() {
        reviewCard.addSubview(reviewStepLabel)
        reviewCard.addSubview(reviewTitleLabel)
        reviewCard.addSubview(reviewDetailLabel)
        reviewCard.addSubview(reviewMetricsLabel)
        reviewCard.addSubview(shareButton)
        reviewCard.addSubview(scanAgainButton)

        [reviewStepLabel, reviewTitleLabel, reviewDetailLabel, reviewMetricsLabel, shareButton, scanAgainButton].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
        }

        reviewStepLabel.font = UIFont.monospacedSystemFont(ofSize: 10, weight: .medium)
        reviewStepLabel.textColor = UIColor(red: 0.59, green: 0.85, blue: 0.7, alpha: 1)
        reviewTitleLabel.font = UIFont.systemFont(ofSize: 24, weight: .semibold)
        reviewTitleLabel.textColor = .white
        reviewTitleLabel.numberOfLines = 2
        reviewDetailLabel.font = UIFont.systemFont(ofSize: 14, weight: .regular)
        reviewDetailLabel.textColor = UIColor(white: 0.78, alpha: 1)
        reviewDetailLabel.numberOfLines = 0
        reviewMetricsLabel.font = UIFont.monospacedSystemFont(ofSize: 12, weight: .medium)
        reviewMetricsLabel.textColor = UIColor(red: 1.0, green: 0.76, blue: 0.48, alpha: 1)
        reviewMetricsLabel.numberOfLines = 0

        configureButton(shareButton, title: "SHARE SESSION", filled: true)
        configureButton(scanAgainButton, title: "SCAN AGAIN", filled: false)
        shareButton.addTarget(self, action: #selector(shareSession), for: .touchUpInside)
        scanAgainButton.addTarget(self, action: #selector(startScan), for: .touchUpInside)

        NSLayoutConstraint.activate([
            reviewCard.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            reviewCard.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            reviewCard.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            reviewStepLabel.topAnchor.constraint(equalTo: reviewCard.topAnchor, constant: 18),
            reviewStepLabel.leadingAnchor.constraint(equalTo: reviewCard.leadingAnchor, constant: 18),
            reviewTitleLabel.topAnchor.constraint(equalTo: reviewStepLabel.bottomAnchor, constant: 8),
            reviewTitleLabel.leadingAnchor.constraint(equalTo: reviewCard.leadingAnchor, constant: 18),
            reviewTitleLabel.trailingAnchor.constraint(equalTo: reviewCard.trailingAnchor, constant: -18),
            reviewDetailLabel.topAnchor.constraint(equalTo: reviewTitleLabel.bottomAnchor, constant: 8),
            reviewDetailLabel.leadingAnchor.constraint(equalTo: reviewCard.leadingAnchor, constant: 18),
            reviewDetailLabel.trailingAnchor.constraint(equalTo: reviewCard.trailingAnchor, constant: -18),
            reviewMetricsLabel.topAnchor.constraint(equalTo: reviewDetailLabel.bottomAnchor, constant: 16),
            reviewMetricsLabel.leadingAnchor.constraint(equalTo: reviewCard.leadingAnchor, constant: 18),
            reviewMetricsLabel.trailingAnchor.constraint(equalTo: reviewCard.trailingAnchor, constant: -18),
            shareButton.topAnchor.constraint(equalTo: reviewMetricsLabel.bottomAnchor, constant: 16),
            shareButton.leadingAnchor.constraint(equalTo: reviewCard.leadingAnchor, constant: 18),
            shareButton.trailingAnchor.constraint(equalTo: scanAgainButton.leadingAnchor, constant: -10),
            shareButton.bottomAnchor.constraint(equalTo: reviewCard.bottomAnchor, constant: -18),
            shareButton.heightAnchor.constraint(equalToConstant: 44),
            scanAgainButton.topAnchor.constraint(equalTo: reviewMetricsLabel.bottomAnchor, constant: 16),
            scanAgainButton.trailingAnchor.constraint(equalTo: reviewCard.trailingAnchor, constant: -18),
            scanAgainButton.bottomAnchor.constraint(equalTo: reviewCard.bottomAnchor, constant: -18),
            scanAgainButton.heightAnchor.constraint(equalToConstant: 44),
            scanAgainButton.widthAnchor.constraint(equalTo: shareButton.widthAnchor)
        ])
    }

    private func configureButton(_ button: UIButton, title: String, filled: Bool) {
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = UIFont.monospacedSystemFont(ofSize: 11, weight: .bold)
        button.layer.cornerRadius = 8
        button.layer.borderWidth = 1
        if filled {
            button.backgroundColor = UIColor(red: 1.0, green: 0.66, blue: 0.35, alpha: 1)
            button.setTitleColor(UIColor(white: 0.08, alpha: 1), for: .normal)
            button.layer.borderColor = UIColor(red: 1.0, green: 0.66, blue: 0.35, alpha: 1).cgColor
        } else {
            button.backgroundColor = .clear
            button.setTitleColor(.white, for: .normal)
            button.layer.borderColor = UIColor(white: 1, alpha: 0.3).cgColor
        }
    }

    @objc private func startScan() {
        guard ARWorldTrackingConfiguration.isSupported else { return }

        let configuration = ARWorldTrackingConfiguration()
        configuration.worldAlignment = .gravity
        configuration.isLightEstimationEnabled = true
        configuration.environmentTexturing = .automatic
        hasSceneClassification = ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification)
        hasSceneReconstruction = hasSceneClassification || ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        if hasSceneClassification {
            configuration.sceneReconstruction = .meshWithClassification
        } else if hasSceneReconstruction {
            configuration.sceneReconstruction = .mesh
        }
        sceneView.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])

        isScanning = true
        currentStep = .ready
        originTransform = nil
        instructionStartPosition = nil
        instructionStartYaw = nil
        lastCapturedPosition = nil
        lastCapturedYaw = nil
        capturedFrames.removeAll(keepingCapacity: true)
        meshAnchors.removeAll(keepingCapacity: true)
        detectedObjects.removeAll(keepingCapacity: true)
        visionRequestInFlight = false
        beginSession()
        stepStartFrameCount = 0
        stepStartTime = 0
        reviewCard.isHidden = true
        instructionCard.isHidden = false
        updateInterface()
    }

    @objc private func finishScan() {
        guard currentStep == .complete else { return }
        isScanning = false
        sceneView.session.pause()
        manifestURL = writeManifest()
        trackingLabel.text = manifestURL == nil
            ? "SCAN COMPLETE / \(capturedFrames.count) FRAMES"
            : "SCAN SAVED / \(capturedFrames.count) FRAMES"
        instructionCard.isHidden = true
        reviewCard.isHidden = false
        updateReviewInterface()
    }

    @objc private func shareSession() {
        guard let manifestURL else { return }

        var shareItems: [Any] = [manifestURL]
        if let sessionDirectoryURL {
            let frameURLs = capturedFrames.compactMap { frame -> URL? in
                guard let imageFileName = frame.imageFileName else { return nil }
                return sessionDirectoryURL.appendingPathComponent(imageFileName)
            }
            shareItems.append(contentsOf: frameURLs)
        }

        let shareController = UIActivityViewController(activityItems: shareItems, applicationActivities: nil)
        if let popover = shareController.popoverPresentationController {
            popover.sourceView = shareButton
            popover.sourceRect = shareButton.bounds
        }
        present(shareController, animated: true)
    }

    private func beginSession() {
        let newSessionID = UUID().uuidString
        sessionID = newSessionID
        sessionStartedAt = Date()
        manifestURL = nil

        let sessionsDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ScanSessions", isDirectory: true)
        let directory = sessionsDirectory.appendingPathComponent(newSessionID, isDirectory: true)

        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            sessionDirectoryURL = directory
        } catch {
            sessionDirectoryURL = nil
        }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let camera = frame.camera
        let currentPosition = position(from: camera.transform)
        let currentYaw = camera.eulerAngles.y

        updateTrackingState(camera.trackingState)

        guard isScanning, case .normal = camera.trackingState else { return }

        if originTransform == nil {
            originTransform = camera.transform
            instructionStartPosition = currentPosition
            instructionStartYaw = currentYaw
            currentStep = .moveForward
            stepStartTime = frame.timestamp
            updateInterface()
            return
        }

        captureIfUseful(frame: frame, position: currentPosition, yaw: currentYaw)
        evaluate(currentPosition: currentPosition, currentYaw: currentYaw, timestamp: frame.timestamp)
        updateTelemetry(position: currentPosition, yaw: currentYaw, camera: camera)
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        updateTrackingState(camera.trackingState)
    }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        anchors.compactMap { $0 as? ARMeshAnchor }.forEach { meshAnchors[$0.identifier] = $0 }
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        anchors.compactMap { $0 as? ARMeshAnchor }.forEach { meshAnchors[$0.identifier] = $0 }
    }

    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        anchors.compactMap { $0 as? ARMeshAnchor }.forEach { meshAnchors.removeValue(forKey: $0.identifier) }
    }

    func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return nil }
        let node = SCNNode()
        node.geometry = sceneGeometry(for: meshAnchor)
        return node
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return }
        node.geometry = sceneGeometry(for: meshAnchor)
    }

    private func sceneGeometry(for anchor: ARMeshAnchor) -> SCNGeometry {
        let mesh = anchor.geometry
        let vertexSource = SCNGeometrySource(
            buffer: mesh.vertices.buffer,
            vertexFormat: mesh.vertices.format,
            semantic: .vertex,
            vertexCount: mesh.vertices.count,
            dataOffset: mesh.vertices.offset,
            dataStride: mesh.vertices.stride
        )
        let faceElement = SCNGeometryElement(
            buffer: mesh.faces.buffer,
            primitiveType: .triangles,
            primitiveCount: mesh.faces.count,
            bytesPerIndex: mesh.faces.bytesPerIndex
        )
        let geometry = SCNGeometry(sources: [vertexSource], elements: [faceElement])
        let material = SCNMaterial()
        material.diffuse.contents = UIColor(red: 1.0, green: 0.76, blue: 0.48, alpha: 1)
        material.transparency = 0.18
        material.isDoubleSided = true
        material.fillMode = .lines
        geometry.materials = [material]
        return geometry
    }

    private func evaluate(currentPosition: SIMD3<Float>, currentYaw: Float, timestamp: TimeInterval) {
        guard let startPosition = instructionStartPosition, let startYaw = instructionStartYaw else { return }
        let horizontalDelta = SIMD2<Float>(currentPosition.x - startPosition.x, currentPosition.z - startPosition.z)
        let yawChange = abs(shortestAngle(from: startYaw, to: currentYaw))

        switch currentStep {
        case .moveForward:
            let distance = max(0, dot(horizontalDelta, forwardVector(yaw: startYaw)))
            updateStepProgress(distance / 1.0)
            if distance >= 0.9 { moveTo(.turnRight, position: currentPosition, yaw: currentYaw, timestamp: timestamp) }
        case .turnRight:
            updateStepProgress(yawChange / (.pi / 2))
            if yawChange >= (.pi / 2 - .pi / 18) { moveTo(.scanWall, position: currentPosition, yaw: currentYaw, timestamp: timestamp) }
        case .scanWall:
            let frameCount = capturedFrames.count - stepStartFrameCount
            updateStepProgress(Float(frameCount) / 6.0)
            if frameCount >= 6 && timestamp - stepStartTime > 1.5 { moveTo(.moveLeft, position: currentPosition, yaw: currentYaw, timestamp: timestamp) }
        case .moveLeft:
            let distance = max(0, dot(horizontalDelta, leftVector(yaw: startYaw)))
            updateStepProgress(distance / 0.8)
            if distance >= 0.65 { moveTo(.scanOpposite, position: currentPosition, yaw: currentYaw, timestamp: timestamp) }
        case .scanOpposite:
            let frameCount = capturedFrames.count - stepStartFrameCount
            updateStepProgress(Float(frameCount) / 6.0)
            if frameCount >= 6 && timestamp - stepStartTime > 1.5 { moveTo(.returnToStart, position: currentPosition, yaw: currentYaw, timestamp: timestamp) }
        case .returnToStart:
            guard let originTransform else { return }
            let originPosition = position(from: originTransform)
            let distance = simd_distance(currentPosition, originPosition)
            updateStepProgress(1 - min(distance / 0.8, 1))
            if distance <= 0.25 { moveTo(.complete, position: currentPosition, yaw: currentYaw, timestamp: timestamp) }
        case .ready, .complete:
            break
        }
    }

    private func moveTo(_ step: ScanStep, position: SIMD3<Float>, yaw: Float, timestamp: TimeInterval) {
        currentStep = step
        instructionStartPosition = position
        instructionStartYaw = yaw
        stepStartFrameCount = capturedFrames.count
        stepStartTime = timestamp
        updateInterface()
    }

    private func captureIfUseful(frame: ARFrame, position: SIMD3<Float>, yaw: Float) {
        let movedEnough: Bool
        if let lastCapturedPosition {
            movedEnough = simd_distance(position, lastCapturedPosition) >= 0.15
        } else {
            movedEnough = true
        }
        let rotatedEnough: Bool
        if let lastCapturedYaw {
            rotatedEnough = abs(shortestAngle(from: lastCapturedYaw, to: yaw)) >= (.pi / 18)
        } else {
            rotatedEnough = true
        }
        guard movedEnough || rotatedEnough else { return }

        let frameID = capturedFrames.count + 1
        let imageFileName = writeFrameImage(frame.capturedImage, frameID: frameID)
        let captured = CapturedFrame(
            id: frameID,
            timestamp: frame.timestamp,
            position: position,
            yaw: yaw,
            imageFileName: imageFileName
        )
        capturedFrames.append(captured)
        lastCapturedPosition = position
        lastCapturedYaw = yaw
        if #available(iOS 17.0, *) {
            classifyFrame(frame, frameID: frameID, position: position)
        }
    }

    @available(iOS 17.0, *)
    private func classifyFrame(_ frame: ARFrame, frameID: Int, position: SIMD3<Float>) {
        guard !visionRequestInFlight else { return }
        visionRequestInFlight = true
        let pixelBuffer = frame.capturedImage
        visionQueue.async { [weak self] in
            guard let self else { return }
            defer { self.visionRequestInFlight = false }
            let request = VNClassifyImageRequest()
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
            try? handler.perform([request])
            let furnitureKeywords = ["bed", "chair", "couch", "sofa", "table", "desk", "cabinet", "wardrobe", "shelf", "dresser"]
            guard let observation = request.results?.first(where: { result in
                furnitureKeywords.contains { result.identifier.lowercased().contains($0) }
            }) else { return }

            let detected = DetectedObject(
                label: observation.identifier,
                confidence: observation.confidence,
                x: position.x,
                y: position.y,
                z: position.z,
                frameID: frameID,
                source: "Vision image classification"
            )
            DispatchQueue.main.async {
                guard !self.detectedObjects.contains(where: { $0.label == detected.label && $0.frameID == detected.frameID }) else { return }
                self.detectedObjects.append(detected)
            }
        }
    }

    private func writeFrameImage(_ pixelBuffer: CVPixelBuffer, frameID: Int) -> String? {
        guard let sessionDirectoryURL else { return nil }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let fileName = String(format: "frame-%04d.jpg", frameID)
        let fileURL = sessionDirectoryURL.appendingPathComponent(fileName)
        let colorSpace = CGColorSpaceCreateDeviceRGB()

        guard let jpegData = imageContext.jpegRepresentation(
            of: image,
            colorSpace: colorSpace,
            options: [.lossyCompressionQuality: 0.78]
        ) else {
            return nil
        }

        do {
            try jpegData.write(to: fileURL, options: .atomic)
            return fileName
        } catch {
            return nil
        }
    }

    private func meshClassificationSummary() -> [String: Int] {
        var summary: [String: Int] = [:]
        for anchor in meshAnchors.values {
            for faceIndex in 0..<anchor.geometry.faces.count {
                let classification = hasSceneClassification ? anchor.geometry.classificationOf(faceWithIndex: faceIndex) : .none
                let label = classification.label
                summary[label, default: 0] += 1
            }
        }
        return summary
    }

    private func makePLY() -> String? {
        guard !meshAnchors.isEmpty else { return nil }

        let origin = originTransform.map { position(from: $0) } ?? SIMD3<Float>(repeating: 0)
        var vertices: [SIMD3<Float>] = []
        var faces: [(a: Int, b: Int, c: Int, classification: UInt8)] = []

        for anchor in meshAnchors.values.sorted(by: { $0.identifier.uuidString < $1.identifier.uuidString }) {
            let mesh = anchor.geometry
            let vertexOffset = vertices.count
            for vertexIndex in 0..<mesh.vertices.count {
                let local = vertexPosition(at: vertexIndex, source: mesh.vertices)
                let world = anchor.transform * SIMD4<Float>(local.x, local.y, local.z, 1)
                vertices.append(SIMD3<Float>(world.x - origin.x, world.y - origin.y, world.z - origin.z))
            }
            for faceIndex in 0..<mesh.faces.count {
                let indices = triangleIndices(at: faceIndex, element: mesh.faces)
                let classificationValue = hasSceneClassification ? mesh.classificationOf(faceWithIndex: faceIndex).rawValue : ARMeshClassification.none.rawValue
                let classification = UInt8(truncatingIfNeeded: classificationValue)
                faces.append((vertexOffset + indices.0, vertexOffset + indices.1, vertexOffset + indices.2, classification))
            }
        }

        guard !vertices.isEmpty, !faces.isEmpty else { return nil }
        var lines: [String] = []
        lines.reserveCapacity(vertices.count + faces.count + 15)
        lines.append("ply")
        lines.append("format ascii 1.0")
        lines.append("comment BuildWise SmartScan ARKit classified mesh")
        lines.append("element vertex \(vertices.count)")
        lines.append("property float x")
        lines.append("property float y")
        lines.append("property float z")
        lines.append("element face \(faces.count)")
        lines.append("property list uchar int vertex_indices")
        lines.append("property uchar classification")
        lines.append("end_header")
        vertices.forEach { lines.append(String(format: "%.5f %.5f %.5f", $0.x, $0.y, $0.z)) }
        faces.forEach { lines.append("3 \($0.a) \($0.b) \($0.c) \($0.classification)") }
        return lines.joined(separator: "\n")
    }

    private func vertexPosition(at index: Int, source: ARGeometrySource) -> SIMD3<Float> {
        let address = source.buffer.contents().advanced(by: source.offset + (index * source.stride))
        let pointer = address.assumingMemoryBound(to: Float.self)
        return SIMD3<Float>(pointer[0], pointer[1], pointer[2])
    }

    private func triangleIndices(at index: Int, element: ARGeometryElement) -> (Int, Int, Int) {
        let byteOffset = element.offset + (index * element.indexCountPerPrimitive * element.bytesPerIndex)
        let address = element.buffer.contents().advanced(by: byteOffset)
        if element.bytesPerIndex == MemoryLayout<UInt16>.size {
            let pointer = address.assumingMemoryBound(to: UInt16.self)
            return (Int(pointer[0]), Int(pointer[1]), Int(pointer[2]))
        }
        let pointer = address.assumingMemoryBound(to: UInt32.self)
        return (Int(pointer[0]), Int(pointer[1]), Int(pointer[2]))
    }

    private func writeManifest() -> URL? {
        guard let sessionID, let sessionDirectoryURL else { return nil }

        let exportedFrames = capturedFrames.map { frame in
            ExportedFrame(
                id: frame.id,
                timestamp: frame.timestamp,
                x: frame.position.x,
                y: frame.position.y,
                z: frame.position.z,
                yaw: frame.yaw,
                imageFileName: frame.imageFileName
            )
        }
        let duration = sessionStartedAt.map { Date().timeIntervalSince($0) } ?? 0
        let originPosition: [Float]?
        if let originTransform {
            let origin = position(from: originTransform)
            originPosition = [origin.x, origin.y, origin.z]
        } else {
            originPosition = nil
        }
        let manifest = ScanSessionManifest(
            schemaVersion: 1,
            sessionID: sessionID,
            coordinateSystem: "ARKit world space, metres",
            origin: originPosition,
            createdAt: sessionStartedAt ?? Date(),
            durationSeconds: duration,
            coveragePercent: Int(currentStep.coverage),
            frameCount: capturedFrames.count,
            frames: exportedFrames,
            meshPLY: makePLY(),
            surfaceSummary: meshClassificationSummary(),
            detectedObjects: detectedObjects
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

        guard let data = try? encoder.encode(manifest) else { return nil }
        let manifestURL = sessionDirectoryURL.appendingPathComponent("manifest.json")
        do {
            try data.write(to: manifestURL, options: .atomic)
            return manifestURL
        } catch {
            return nil
        }
    }

    private func updateReviewInterface() {
        let savedFrames = capturedFrames.filter { $0.imageFileName != nil }.count
        let duration = sessionStartedAt.map { Date().timeIntervalSince($0) } ?? 0
        let durationText = String(format: "%02d:%02d", Int(duration) / 60, Int(duration) % 60)

        reviewStepLabel.text = manifestURL == nil ? "SCAN COMPLETE" : "SCAN SAVED"
        reviewTitleLabel.text = "Room scan is ready"
        reviewDetailLabel.text = manifestURL == nil
            ? "The scan is complete, but the session could not be written to local storage."
            : hasSceneReconstruction
                ? hasSceneClassification
                    ? "Your room mesh, classified surfaces, AI observations, and tracking path are stored locally and ready to share."
                    : "Your room mesh and tracking path are stored locally. Surface classification needs a LiDAR device that supports it."
                : "Your keyframes and tracking path are stored locally. A LiDAR device is needed for a room mesh."
        let meshText = hasSceneReconstruction ? "\(meshAnchors.count) chunks" : "not available"
        reviewMetricsLabel.text = "COVERAGE  /  \(Int(currentStep.coverage))%\nFRAMES    /  \(capturedFrames.count) total / \(savedFrames) images\nROOM MESH /  \(meshText)\nAI OBJECTS /  \(detectedObjects.count) observations\nDURATION  /  \(durationText)"
        shareButton.isEnabled = manifestURL != nil
        shareButton.alpha = manifestURL == nil ? 0.45 : 1
    }

    private func updateTrackingState(_ state: ARCamera.TrackingState) {
        let text: String
        let color: UIColor
        switch state {
        case .normal:
            if isScanning && hasSceneReconstruction {
                text = "TRACKING + ROOM MESH / LIVE"
            } else {
                text = isScanning ? "TRACKING / LIVE CAMERA" : "AR WORLD TRACKING READY"
            }
            color = UIColor(red: 0.59, green: 0.85, blue: 0.7, alpha: 1)
        case .limited(let reason):
            text = "TRACKING LIMITED / \(reason.label)"
            color = UIColor(red: 1.0, green: 0.76, blue: 0.48, alpha: 1)
        case .notAvailable:
            text = "AR TRACKING UNAVAILABLE"
            color = .systemRed
        }
        DispatchQueue.main.async {
            self.trackingLabel.text = text
            self.trackingLabel.textColor = color
        }
    }

    private func updateInterface() {
        DispatchQueue.main.async {
            self.instructionStepLabel.text = self.currentStep == .complete ? "SCAN COMPLETE" : "GUIDED SMARTSCAN"
            self.instructionTitleLabel.text = self.currentStep.title
            self.instructionDetailLabel.text = self.currentStep.instruction
            self.targetLabel.text = "TARGET  /  \(self.currentStep.target)"
            self.coverageLabel.text = "\(Int(self.currentStep.coverage))% COVERAGE"
            self.coverageProgress.setProgress(self.currentStep.coverage / 100, animated: true)
            self.startButton.isHidden = self.isScanning
            self.finishButton.isHidden = self.currentStep != .complete
        }
    }

    private func updateStepProgress(_ progress: Float) {
        let clamped = max(0, min(progress, 1))
        DispatchQueue.main.async {
            self.targetLabel.text = "TARGET  /  \(self.currentStep.target)  /  \(Int(clamped * 100))%"
        }
    }

    private func updateTelemetry(position: SIMD3<Float>, yaw: Float, camera: ARCamera) {
        let tracking = camera.trackingState.label
        let text = String(format: "X %.2f m   Y %.2f m   Z %.2f m\nYaw %.0f deg   %@   Frames %02d", position.x, position.y, position.z, yaw * 180 / .pi, tracking, capturedFrames.count)
        DispatchQueue.main.async { self.telemetryLabel.text = text }
    }

    private func position(from transform: simd_float4x4) -> SIMD3<Float> {
        SIMD3<Float>(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
    }

    private func forwardVector(yaw: Float) -> SIMD2<Float> {
        SIMD2<Float>(-sin(yaw), -cos(yaw))
    }

    private func leftVector(yaw: Float) -> SIMD2<Float> {
        SIMD2<Float>(-cos(yaw), sin(yaw))
    }

    private func dot(_ lhs: SIMD2<Float>, _ rhs: SIMD2<Float>) -> Float {
        lhs.x * rhs.x + lhs.y * rhs.y
    }

    private func shortestAngle(from: Float, to: Float) -> Float {
        atan2(sin(to - from), cos(to - from))
    }
}

private extension ARMeshClassification {
    var label: String {
        switch self {
        case .none: return "unclassified"
        case .wall: return "wall"
        case .floor: return "floor"
        case .ceiling: return "ceiling"
        case .table: return "table"
        case .seat: return "seat"
        case .window: return "window"
        case .door: return "door"
        @unknown default: return "other"
        }
    }
}

private extension ARCamera.TrackingState.Reason {
    var label: String {
        switch self {
        case .initializing: return "INITIALIZING"
        case .excessiveMotion: return "MOVE SLOWER"
        case .insufficientFeatures: return "NEED MORE DETAIL"
        case .relocalizing: return "RELOCALIZING"
        @unknown default: return "RECOVERING"
        }
    }
}

private extension ARCamera.TrackingState {
    var label: String {
        switch self {
        case .normal: return "NORMAL"
        case .limited(let reason): return reason.label
        case .notAvailable: return "UNAVAILABLE"
        }
    }
}
