import Foundation
import Combine

struct DiscoveredController: Identifiable {
    let id: String
    let name: String
    let address: String
}
@MainActor final class ControllerDiscovery: NSObject, ObservableObject, @preconcurrency NetServiceBrowserDelegate, @preconcurrency NetServiceDelegate {
    @Published private(set) var controllers: [DiscoveredController] = []
    @Published private(set) var error: String?
    private let browser = NetServiceBrowser()
    private var services: [NetService] = []
    override init() { super.init(); browser.delegate = self }
    func start() { stop(); error = nil; browser.searchForServices(ofType: "_flashify._tcp.", inDomain: "local.") }
    func stop() { browser.stop(); services.forEach { $0.stop() }; services.removeAll(); controllers.removeAll() }
    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        services.append(service); service.delegate = self; service.resolve(withTimeout: 5)
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        services.removeAll { $0 == service }; controllers.removeAll { $0.id == service.domain + service.type + service.name }
    }
    func netServiceDidResolveAddress(_ sender: NetService) {
        guard services.contains(sender), let host = sender.hostName, sender.port > 0 else { return }
        let id = sender.domain + sender.type + sender.name
        controllers.removeAll { $0.id == id }
        controllers.append(DiscoveredController(id: id, name: sender.name, address: "http://\(host):\(sender.port)"))
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        error = "Controller discovery is unavailable. Enter its address manually and check Local Network access in Settings."
    }
}
