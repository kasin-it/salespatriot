// Generates DEMO FIXTURE material (fictional product + manufacturer) from <set>/product.json.
// Usage (macOS):  swift generate.swift thermal     |     swift generate.swift drone
// Edit product.json to match the physical item you bring on stage, then regenerate.
import AppKit
import CoreGraphics

let setName = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "thermal"
let dir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(setName)
let cfg = try! JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("product.json"))) as! [String: Any]
let manufacturer = cfg["manufacturer"] as! String
let model = cfg["model"] as! String
let title = cfg["title"] as! String
let flyerRows = cfg["flyerRows"] as! [String]
let specRows = cfg["specRows"] as! [[String]]
let commercial = (cfg["commercial"] as! [String]).joined(separator: "\n")
let exportNote = cfg["exportNote"] as! String
let slidesCfg = cfg["slides"] as! [[String: Any]]
let illustration = cfg["illustration"] as! String

let navy = NSColor(red: 0.06, green: 0.09, blue: 0.16, alpha: 1)
let amber = NSColor(red: 0.96, green: 0.62, blue: 0.04, alpha: 1)
let grey = NSColor(white: 0.35, alpha: 1)
let red = NSColor(red: 0.8, green: 0.1, blue: 0.1, alpha: 1)

func font(_ s: CGFloat, _ bold: Bool = false) -> NSFont { bold ? NSFont.boldSystemFont(ofSize: s) : NSFont.systemFont(ofSize: s) }
/// y is the bottom of the FIRST line; extra lines flow downwards from it.
func text(_ s: String, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat, bold: Bool = false, color: NSColor = .black, width: CGFloat = 900) {
  let p = NSMutableParagraphStyle(); p.lineBreakMode = .byWordWrapping
  let attrs: [NSAttributedString.Key: Any] = [.font: font(size, bold), .foregroundColor: color, .paragraphStyle: p]
  let h = ceil((s as NSString).boundingRect(with: NSSize(width: width, height: 0), options: .usesLineFragmentOrigin, attributes: attrs).height)
  let lineH = ceil(size * 1.25)
  (s as NSString).draw(in: NSRect(x: x, y: y + lineH - h, width: width, height: h), withAttributes: attrs)
}
func rrect(_ r: NSRect, _ rad: CGFloat, fill: NSColor, stroke: NSColor? = nil, line: CGFloat = 0) {
  let p = NSBezierPath(roundedRect: r, xRadius: rad, yRadius: rad); fill.setFill(); p.fill()
  if let s = stroke { s.setStroke(); p.lineWidth = line; p.stroke() }
}
func oval(_ r: NSRect, fill: NSColor, stroke: NSColor? = nil, line: CGFloat = 0) {
  let p = NSBezierPath(ovalIn: r); fill.setFill(); p.fill()
  if let s = stroke { s.setStroke(); p.lineWidth = line; p.stroke() }
}

func drawCamera() {
  rrect(NSRect(x: 90, y: 330, width: 640, height: 360), 60, fill: NSColor(white: 0.16, alpha: 1), stroke: NSColor(white: 0.4, alpha: 1), line: 6)
  oval(NSRect(x: 420, y: 380, width: 270, height: 270), fill: NSColor(red: 0.05, green: 0.2, blue: 0.3, alpha: 1), stroke: amber, line: 12)
  oval(NSRect(x: 510, y: 520, width: 50, height: 50), fill: NSColor(red: 0.3, green: 0.7, blue: 0.9, alpha: 0.6))
  rrect(NSRect(x: 150, y: 430, width: 210, height: 150), 18, fill: NSColor(white: 0.25, alpha: 1))
  text(model, 175, 480, 54, bold: true, color: amber, width: 200)
}
func drawDrone() {
  let c = NSPoint(x: 410, y: 500)
  NSColor(white: 0.3, alpha: 1).setStroke()
  for (dx, dy) in [(-250.0, 130.0), (250.0, 130.0), (-250.0, -130.0), (250.0, -130.0)] {
    let arm = NSBezierPath(); arm.move(to: c); arm.line(to: NSPoint(x: c.x + dx, y: c.y + dy)); arm.lineWidth = 22; NSColor(white: 0.22, alpha: 1).setStroke(); arm.stroke()
    oval(NSRect(x: c.x + dx - 85, y: c.y + dy - 85, width: 170, height: 170), fill: NSColor(white: 0.5, alpha: 0.28), stroke: NSColor(white: 0.6, alpha: 1), line: 4)
    oval(NSRect(x: c.x + dx - 18, y: c.y + dy - 18, width: 36, height: 36), fill: NSColor(white: 0.15, alpha: 1))
  }
  rrect(NSRect(x: c.x - 105, y: c.y - 55, width: 210, height: 110), 40, fill: NSColor(white: 0.16, alpha: 1), stroke: NSColor(white: 0.45, alpha: 1), line: 5)
  oval(NSRect(x: c.x - 36, y: c.y - 110, width: 72, height: 72), fill: NSColor(red: 0.05, green: 0.2, blue: 0.3, alpha: 1), stroke: amber, line: 8)
  text(model, c.x - 45, c.y - 12, 34, bold: true, color: amber, width: 120)
}

// ---- 1. Photo-style flyer (PNG, 1600x1000) ------------------------------------------------------
do {
  let W: CGFloat = 1600, H: CGFloat = 1000
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W), pixelsHigh: Int(H), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  navy.setFill(); NSRect(x: 0, y: 0, width: W, height: H).fill()
  if illustration == "drone" { drawDrone() } else { drawCamera() }
  text(manufacturer, 90, 860, 34, bold: true, color: amber)
  text(title, 90, 790, title.count > 40 ? 40 : 54, bold: true, color: .white, width: 1450)
  rrect(NSRect(x: 800, y: 130, width: 720, height: 630), 24, fill: .white)
  let step: CGFloat = flyerRows.count > 9 ? 58 : 62
  for (i, r) in flyerRows.enumerated() { text(r, 826, 700 - CGFloat(i) * step, flyerRows.count > 9 ? 27 : 29, bold: i < 3, color: .black, width: 680) }
  red.setFill(); NSRect(x: 0, y: 0, width: W, height: 90).fill()
  text("DEMO FIXTURE — FICTIONAL PRODUCT AND MANUFACTURER, NOT A REAL OFFER", 40, 28, 30, bold: true, color: .white, width: 1500)
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: dir.appendingPathComponent(cfg["photoFile"] as! String))
}

// ---- PDF helpers ---------------------------------------------------------------------------------------
func pdf(_ name: String, size: CGSize, pages: [() -> Void]) {
  var box = CGRect(origin: .zero, size: size)
  let ctx = CGContext(dir.appendingPathComponent(name) as CFURL, mediaBox: &box, nil)!
  for p in pages {
    ctx.beginPDFPage(nil)
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    p()
    NSGraphicsContext.restoreGraphicsState(); ctx.endPDFPage()
  }
  ctx.closePDF()
}
func banner(_ w: CGFloat) { red.setFill(); NSRect(x: 0, y: 0, width: w, height: 28).fill(); text("DEMO FIXTURE — fictional product and manufacturer, not a real offer", 14, 6, 11, bold: true, color: .white, width: w - 20) }

// ---- 2. Specification sheet (PDF, A4) ----------------------------------------------------------------
pdf(cfg["specFile"] as! String, size: CGSize(width: 595, height: 842), pages: [{
  navy.setFill(); NSRect(x: 0, y: 742, width: 595, height: 100).fill()
  text(manufacturer, 40, 800, 12, bold: true, color: amber, width: 400)
  text("\(title) — Technical Specification", 40, 765, 18, bold: true, color: .white, width: 520)
  for (i, l) in specRows.enumerated() { let y = 700 - CGFloat(i) * 28; text(l[0], 40, y, 11, bold: true, color: grey, width: 200); text(l[1], 250, y, 11, width: 310) }
  text("Commercial information", 40, 290, 14, bold: true, color: amber, width: 400)
  text(commercial, 40, 255, 12, width: 500)
  text(exportNote, 40, 160, 11, color: grey, width: 520)
  banner(595)
}])

// ---- 3. Product presentation (PDF, landscape slides) -------------------------------------------------------
pdf(cfg["presentationFile"] as! String, size: CGSize(width: 960, height: 540), pages: slidesCfg.map { sl in {
  navy.setFill(); NSRect(x: 0, y: 0, width: 960, height: 540).fill()
  amber.setFill(); NSRect(x: 40, y: 430, width: 60, height: 5).fill()
  text(sl["title"] as! String, 40, 450, 32, bold: true, color: .white, width: 880)
  for (i, b) in (sl["bullets"] as! [String]).enumerated() { text("•  " + b, 50, 380 - CGFloat(i) * 56, 21, color: NSColor(white: 0.92, alpha: 1), width: 860) }
  banner(960)
} })
print("generated \(setName)")
