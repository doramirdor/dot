// nina-ax — Nina's macOS Accessibility bridge
//
// Compiled once into ~/.nina/bin/nina-ax by src/main/native-ax.ts on first use.
// Reads AND drives the accessibility tree of native macOS apps.
//
// Commands:
//   nina-ax                                    # dump frontmost window as JSON
//   nina-ax read [--depth N] [--max-nodes N]   # same as above, explicit
//   nina-ax check                              # check if AX is trusted
//   nina-ax click --role R --title T           # click an element by role+title
//   nina-ax click --x N --y N                  # click at screen coordinates
//   nina-ax type --role R --title T --text S   # type into a text field by role+title
//   nina-ax type --x N --y N --text S          # type into field at coordinates
//   nina-ax press --key K                      # press a keyboard key (Return, Escape, Tab, Space, ArrowUp...)
//
// Every command outputs a JSON object to stdout. Errors use
// {"error":"<code>","message":"<human>"}.

import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// ---------- args ----------

enum Command {
    case read
    case check
    case click
    case type
    case press
}

var command: Command = .read
var depthLimit = 10
var nodeBudget = 400
var argRole: String? = nil
var argTitle: String? = nil
var argText: String? = nil
var argX: Double? = nil
var argY: Double? = nil
var argKey: String? = nil

var argList = CommandLine.arguments.dropFirst()
if let first = argList.first {
    switch first {
    case "read":  command = .read;  argList = argList.dropFirst()
    case "check": command = .check; argList = argList.dropFirst()
    case "click": command = .click; argList = argList.dropFirst()
    case "type":  command = .type;  argList = argList.dropFirst()
    case "press": command = .press; argList = argList.dropFirst()
    case "--check": command = .check; argList = argList.dropFirst()
    default: break // default = read with --depth/--max-nodes
    }
}

var iter = argList.makeIterator()
while let arg = iter.next() {
    switch arg {
    case "--depth":
        if let v = iter.next(), let n = Int(v) { depthLimit = n }
    case "--max-nodes":
        if let v = iter.next(), let n = Int(v) { nodeBudget = n }
    case "--role":
        argRole = iter.next()
    case "--title":
        argTitle = iter.next()
    case "--text":
        argText = iter.next()
    case "--x":
        if let v = iter.next() { argX = Double(v) }
    case "--y":
        if let v = iter.next() { argY = Double(v) }
    case "--key":
        argKey = iter.next()
    default:
        break
    }
}

// ---------- json helpers ----------

func emitJson(_ obj: Any) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    } else {
        print("{\"error\":\"json_serialization_failed\"}")
    }
    exit(0)
}

func emitError(_ code: String, _ message: String) -> Never {
    emitJson(["error": code, "message": message])
}

// ---------- AX helpers ----------

func axCopy<T>(_ element: AXUIElement, _ attribute: String) -> T? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success else { return nil }
    return value as? T
}

func getRole(_ element: AXUIElement) -> String? {
    return axCopy(element, kAXRoleAttribute as String)
}

func getTitle(_ element: AXUIElement) -> String? {
    return axCopy(element, kAXTitleAttribute as String)
}

func getFrame(_ element: AXUIElement) -> CGRect? {
    var posValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success else {
        return nil
    }
    var point = CGPoint.zero
    var size = CGSize.zero
    if AXValueGetValue(posValue as! AXValue, .cgPoint, &point),
       AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) {
        return CGRect(origin: point, size: size)
    }
    return nil
}

// Roles worth including in the read output.
let interestingRoles: Set<String> = [
    "AXApplication", "AXWindow", "AXSheet", "AXDialog", "AXMenuBar",
    "AXMenu", "AXMenuItem", "AXMenuBarItem",
    "AXButton", "AXPopUpButton", "AXRadioButton", "AXCheckBox",
    "AXTextField", "AXTextArea", "AXSearchField", "AXStaticText",
    "AXLink", "AXImage", "AXTabGroup", "AXTab",
    "AXToolbar", "AXSplitGroup", "AXGroup",
    "AXList", "AXTable", "AXRow", "AXCell", "AXOutline",
    "AXWebArea", "AXScrollArea", "AXComboBox",
    "AXDisclosureTriangle", "AXSlider", "AXStepper",
]

let attrsToRead: [String] = [
    kAXRoleAttribute as String,
    kAXSubroleAttribute as String,
    kAXRoleDescriptionAttribute as String,
    kAXTitleAttribute as String,
    kAXValueAttribute as String,
    kAXDescriptionAttribute as String,
    kAXHelpAttribute as String,
    kAXPlaceholderValueAttribute as String,
    kAXSelectedAttribute as String,
    kAXEnabledAttribute as String,
]

var nodeCount = 0

func walkAX(_ element: AXUIElement, depth: Int) -> [String: Any]? {
    if nodeCount >= nodeBudget { return nil }

    var obj: [String: Any] = [:]

    guard let role = getRole(element) else { return nil }
    let isInteresting = interestingRoles.contains(role)

    nodeCount += 1
    obj["role"] = role

    if let posValue: AXValue = axCopy(element, kAXPositionAttribute as String) {
        var point = CGPoint.zero
        if AXValueGetValue(posValue, .cgPoint, &point) {
            obj["pos"] = [Int(point.x), Int(point.y)]
        }
    }
    if let sizeValue: AXValue = axCopy(element, kAXSizeAttribute as String) {
        var size = CGSize.zero
        if AXValueGetValue(sizeValue, .cgSize, &size) {
            obj["size"] = [Int(size.width), Int(size.height)]
        }
    }

    for attr in attrsToRead {
        if attr == (kAXRoleAttribute as String) { continue }
        if let s: String = axCopy(element, attr) {
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                let key = attr.replacingOccurrences(of: "AX", with: "").lowercased()
                obj[key] = trimmed.count > 200 ? String(trimmed.prefix(200)) + "…" : trimmed
            }
        }
        if let b: Bool = axCopy(element, attr) {
            let key = attr.replacingOccurrences(of: "AX", with: "").lowercased()
            obj[key] = b
        }
    }

    if depth < depthLimit, nodeCount < nodeBudget,
       let children: [AXUIElement] = axCopy(element, kAXChildrenAttribute as String) {
        var kids: [[String: Any]] = []
        for child in children.prefix(80) {
            if nodeCount >= nodeBudget { break }
            if let k = walkAX(child, depth: depth + 1) {
                kids.append(k)
            }
        }
        if !kids.isEmpty {
            obj["children"] = kids
        }
    }

    if !isInteresting && obj["children"] == nil {
        let textKeys = ["title", "value", "description", "help", "placeholdervalue"]
        let hasText = textKeys.contains { obj[$0] != nil }
        if !hasText { return nil }
    }

    return obj
}

// ---------- element finding (for click/type) ----------

/// Recursively walk the app tree looking for an element matching role + title.
/// Title match is case-insensitive substring. Returns the first hit.
func findElement(
    in root: AXUIElement,
    role targetRole: String?,
    title targetTitle: String?,
    depth: Int = 0,
    maxDepth: Int = 15
) -> AXUIElement? {
    if depth > maxDepth { return nil }

    let elementRole = getRole(root)
    let elementTitle = getTitle(root)
        ?? (axCopy(root, kAXValueAttribute as String) as String?)
        ?? (axCopy(root, kAXDescriptionAttribute as String) as String?)

    var roleMatch = true
    var titleMatch = true

    if let tr = targetRole {
        // Accept "Button" or "AXButton"
        let normalized = tr.hasPrefix("AX") ? tr : "AX\(tr)"
        roleMatch = elementRole == normalized
    }
    if let tt = targetTitle {
        if let etitle = elementTitle {
            titleMatch = etitle.localizedCaseInsensitiveContains(tt)
        } else {
            titleMatch = false
        }
    }

    if roleMatch && titleMatch && targetRole != nil || (targetTitle != nil && titleMatch) {
        // Only return elements that are actionable — i.e., have a real role
        if let r = elementRole, !r.isEmpty, interestingRoles.contains(r) || targetRole != nil {
            return root
        }
    }

    // Recurse into children
    if let children: [AXUIElement] = axCopy(root, kAXChildrenAttribute as String) {
        for child in children {
            if let found = findElement(
                in: child,
                role: targetRole,
                title: targetTitle,
                depth: depth + 1,
                maxDepth: maxDepth
            ) {
                return found
            }
        }
    }

    return nil
}

/// Get the element at a screen coordinate via the system-wide AX element.
func elementAtPoint(_ x: Double, _ y: Double) -> AXUIElement? {
    let systemWide = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    let result = AXUIElementCopyElementAtPosition(
        systemWide,
        Float(x),
        Float(y),
        &element
    )
    if result == .success { return element }
    return nil
}

// ---------- click / type ----------

func performClick(on element: AXUIElement) -> Bool {
    // Try AXPress first (proper AX action for buttons/links)
    if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
        return true
    }
    // Fall back to synthesizing a mouse click at the center of the element
    if let rect = getFrame(element) {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        return synthesizeClick(at: center)
    }
    return false
}

func synthesizeClick(at point: CGPoint) -> Bool {
    guard let down = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseDown,
        mouseCursorPosition: point,
        mouseButton: .left
    ) else { return false }
    guard let up = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseUp,
        mouseCursorPosition: point,
        mouseButton: .left
    ) else { return false }
    down.post(tap: .cghidEventTap)
    usleep(30_000) // 30ms
    up.post(tap: .cghidEventTap)
    return true
}

func performType(on element: AXUIElement, text: String) -> Bool {
    // Focus the element first
    let focusResult = AXUIElementSetAttributeValue(
        element,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    )
    _ = focusResult // may fail silently for some elements

    // Try setting the value attribute directly (works for most text fields)
    if AXUIElementSetAttributeValue(
        element,
        kAXValueAttribute as CFString,
        text as CFString
    ) == .success {
        return true
    }

    // Fall back to selected-text insertion (for TextAreas that only expose
    // kAXSelectedTextAttribute as writable)
    if AXUIElementSetAttributeValue(
        element,
        kAXSelectedTextAttribute as CFString,
        text as CFString
    ) == .success {
        return true
    }

    // Last resort: synthesize keyboard events for the characters
    return synthesizeTyping(text)
}

func synthesizeTyping(_ text: String) -> Bool {
    let src = CGEventSource(stateID: .hidSystemState)
    for char in text.unicodeScalars {
        if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
           let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
            var utf16 = [UniChar(char.value)]
            down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &utf16)
            up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &utf16)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            usleep(8_000)
        }
    }
    return true
}

// Common key name → virtual key code mapping
let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36,
    "tab": 48,
    "space": 49,
    "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53,
    "arrowleft": 123, "left": 123,
    "arrowright": 124, "right": 124,
    "arrowdown": 125, "down": 125,
    "arrowup": 126, "up": 126,
    "home": 115,
    "end": 119,
    "pageup": 116,
    "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118,
    "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func pressKey(_ name: String) -> Bool {
    let normalized = name.lowercased().replacingOccurrences(of: "-", with: "")
    guard let code = keyCodes[normalized] else { return false }
    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    else { return false }
    down.post(tap: .cghidEventTap)
    usleep(30_000)
    up.post(tap: .cghidEventTap)
    return true
}

// ---------- main ----------

if command == .check {
    emitJson(["trusted": AXIsProcessTrusted()])
}

guard AXIsProcessTrusted() else {
    emitError(
        "accessibility_not_granted",
        "Nina's AX helper needs Accessibility permission. Go to System Settings → Privacy & Security → Accessibility and enable the nina-ax binary."
    )
}

guard let app = NSWorkspace.shared.frontmostApplication else {
    emitError("no_frontmost_app", "Couldn't determine the frontmost application.")
}
let appRef = AXUIElementCreateApplication(app.processIdentifier)

switch command {
case .read:
    var target: AXUIElement = appRef
    if let win: AXUIElement = axCopy(appRef, kAXFocusedWindowAttribute as String) {
        target = win
    } else if let windows: [AXUIElement] = axCopy(appRef, kAXWindowsAttribute as String),
              let first = windows.first {
        target = first
    }
    let tree = walkAX(target, depth: 0) ?? [:]
    emitJson([
        "app": app.localizedName ?? "",
        "bundle": app.bundleIdentifier ?? "",
        "pid": app.processIdentifier,
        "nodeCount": nodeCount,
        "tree": tree,
    ])

case .click:
    var target: AXUIElement?
    if let x = argX, let y = argY {
        target = elementAtPoint(x, y)
        if target == nil {
            // synthesize click anyway if we can't resolve an element
            if synthesizeClick(at: CGPoint(x: x, y: y)) {
                emitJson(["ok": true, "method": "synthetic", "x": x, "y": y])
            }
            emitError("click_failed", "Could not synthesize click at (\(x), \(y))")
        }
    } else {
        let searchRoot: AXUIElement = (axCopy(appRef, kAXFocusedWindowAttribute as String) as AXUIElement?) ?? appRef
        target = findElement(in: searchRoot, role: argRole, title: argTitle)
        if target == nil {
            emitError("element_not_found", "No element matching role=\(argRole ?? "*") title=\(argTitle ?? "*")")
        }
    }
    guard let el = target else {
        emitError("click_failed", "No target element")
    }
    if performClick(on: el) {
        let rect = getFrame(el)
        emitJson([
            "ok": true,
            "method": "ax_press",
            "role": getRole(el) ?? "",
            "title": getTitle(el) ?? "",
            "frame": rect.map { [Int($0.origin.x), Int($0.origin.y), Int($0.size.width), Int($0.size.height)] } as Any,
        ])
    } else {
        emitError("click_failed", "AX press and fallback both failed")
    }

case .type:
    guard let text = argText else {
        emitError("missing_arg", "type requires --text")
    }
    var target: AXUIElement?
    if let x = argX, let y = argY {
        target = elementAtPoint(x, y)
    } else {
        let searchRoot: AXUIElement = (axCopy(appRef, kAXFocusedWindowAttribute as String) as AXUIElement?) ?? appRef
        target = findElement(in: searchRoot, role: argRole, title: argTitle)
    }
    guard let el = target else {
        emitError("element_not_found", "No text field matching role=\(argRole ?? "*") title=\(argTitle ?? "*")")
    }
    if performType(on: el, text: text) {
        emitJson([
            "ok": true,
            "role": getRole(el) ?? "",
            "title": getTitle(el) ?? "",
            "length": text.count,
        ])
    } else {
        emitError("type_failed", "Setting value and synthesized typing both failed")
    }

case .press:
    guard let key = argKey else {
        emitError("missing_arg", "press requires --key")
    }
    if pressKey(key) {
        emitJson(["ok": true, "key": key])
    } else {
        emitError("unknown_key", "No virtual key code for '\(key)'. Known: return, tab, space, delete, escape, arrow{up,down,left,right}, home, end, pageup, pagedown, f1-f12")
    }

case .check:
    break // handled above
}
