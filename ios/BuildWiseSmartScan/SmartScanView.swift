import SwiftUI

struct SmartScanView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> ScanViewController {
        ScanViewController()
    }

    func updateUIViewController(_ uiViewController: ScanViewController, context: Context) {}
}
