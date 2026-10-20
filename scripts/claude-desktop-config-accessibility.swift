// Test-only macOS accessibility driver. AX elements are native references bound
// to one PID: System Events can re-resolve same-named Electron processes by name.
import AppKit
import ApplicationServices
import Foundation

enum DriverError: Error { case invalid(String) }
let args = CommandLine.arguments
guard args.count >= 3, let pid = Int32(args[1]), pid > 0 else { fputs("Usage: driver PID COMMAND [ARG ...]\n",stderr); exit(1) }
let app = AXUIElementCreateApplication(pid)
func verify(_ element: AXUIElement) throws {
    var actual: pid_t = 0
    guard AXUIElementGetPid(element, &actual) == .success, actual == pid else { throw DriverError.invalid("AX element left the owned PID") }
}
func get(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    guard (try? verify(element)) != nil else { return nil }
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}
func string(_ element: AXUIElement, _ key: String) -> String { (get(element, key) as? String) ?? "" }
func children(_ element: AXUIElement) -> [AXUIElement] { (get(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func windows() -> [AXUIElement] { (get(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] }
func descendants(_ roots: [AXUIElement]) -> [AXUIElement] {
    var result: [AXUIElement] = [], pending = roots
    while !pending.isEmpty && result.count < 4000 {
        let next = pending.removeFirst()
        result.append(next)
        pending.insert(contentsOf: children(next), at: 0)
    }
    return result
}
func press(_ element: AXUIElement) throws {
    try verify(element)
    guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { throw DriverError.invalid("AXPress failed") }
}
func emit(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}
func find(_ role: String, _ label: String) throws -> AXUIElement {
    guard let element = descendants(windows()).first(where: { e in
        (role.isEmpty || string(e, kAXRoleAttribute) == role) && [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].contains(where: { string(e, $0) == label })
    }) else { throw DriverError.invalid("Missing owned AX element: \(role) \(label)") }
    return element
}
do {
    try verify(app)
    switch args[2] {
    case "activate":
        // Setting these repeatedly can interrupt Chromium accessibility trees.
        // Enable them once, before opening the native configuration window.
        _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        guard NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps]) == true else { throw DriverError.invalid("Owned application cannot activate") }
        try emit(["pid":pid,"activated":true])
    case "menu":
        guard args.count >= 4, let menuValue = get(app, kAXMenuBarAttribute) else { throw DriverError.invalid("Missing owned menu bar") }
        var node = unsafeBitCast(menuValue, to: AXUIElement.self)
        for title in args.dropFirst(3) {
            guard let found = descendants(children(node)).first(where: { string($0, kAXTitleAttribute) == title }) else { throw DriverError.invalid("Missing owned menu: \(title)") }
            try press(found)
            node = found
            usleep(150_000)
        }
        try emit(["pid":pid,"items":descendants(children(node)).map { string($0,kAXTitleAttribute) }.filter { !$0.isEmpty }])
    case "snapshot":
        let elements = descendants(windows())
        try emit(elements.map { e -> [String:Any] in
            var row:[String:Any] = ["pid":pid]
            for (name,key) in [("role",kAXRoleAttribute),("title",kAXTitleAttribute),("description",kAXDescriptionAttribute),("value",kAXValueAttribute)] {
                if let value = get(e,key) as? String, !value.isEmpty { row[name] = String(value.prefix(8000)) }
            }
            return row
        })
    case "press":
        guard args.count == 5 else { throw DriverError.invalid("press requires role and label") }
        try press(find(args[3],args[4])); try emit(["pid":pid,"pressed":args[4]])
    case "set":
        guard args.count == 6 else { throw DriverError.invalid("set requires role, label and value") }
        let element = try find(args[3],args[4]); try verify(element)
        _ = AXUIElementSetAttributeValue(element,kAXFocusedAttribute as CFString,kCFBooleanTrue)
        guard AXUIElementSetAttributeValue(element,kAXValueAttribute as CFString,args[5] as CFString) == .success else { throw DriverError.invalid("Owned AX value is not writable") }
        try emit(["pid":pid,"set":args[4]])
    default: throw DriverError.invalid("Unknown command")
    }
} catch { fputs("\(error)\n",stderr); exit(1) }
