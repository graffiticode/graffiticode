// Build: swiftc -O -module-cache-path /private/tmp/gc-capability-animation/swift-cache
//   render.swift -o /private/tmp/gc-capability-animation/render
// Usage: render <output-directory> preview | video | verify
// Narration: say -v Samantha -r 176 -f narration-N.txt -o scene-N.aiff
import Foundation
import AppKit
import CoreGraphics
import CoreText
import AVFoundation
import CoreVideo
import ImageIO
import UniformTypeIdentifiers

let W = 1920, H = 1080, FPS = 30
let fm = FileManager.default
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let scratch = URL(fileURLWithPath: "/private/tmp/gc-capability-animation")
let mode = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "preview"
let spec = try JSONSerialization.jsonObject(with: Data(contentsOf: output.appendingPathComponent("storyboard.json"))) as! [String: Any]
let scenes = spec["scenes"] as! [[String: Any]]
let N = scenes.count
let DURATION = spec["duration"] as! Int
let FILE = spec["file"] as! String
let TITLE = spec["title"] as! String
precondition(DURATION == N*10, "each scene is 10 seconds")
let bg = NSColor(srgbRed: 0.031, green: 0.049, blue: 0.077, alpha: 1).cgColor
let panel = NSColor(srgbRed: 0.063, green: 0.090, blue: 0.129, alpha: 1).cgColor
let white = NSColor(srgbRed: 0.94, green: 0.96, blue: 0.98, alpha: 1).cgColor
let secondary = NSColor(srgbRed: 0.62, green: 0.69, blue: 0.77, alpha: 1).cgColor
let border = NSColor(srgbRed: 0.18, green: 0.23, blue: 0.29, alpha: 1).cgColor
let teal = NSColor(srgbRed: 0.32, green: 0.89, blue: 0.76, alpha: 1).cgColor
let blue = NSColor(srgbRed: 0.42, green: 0.69, blue: 1.00, alpha: 1).cgColor
let purple = NSColor(srgbRed: 0.74, green: 0.62, blue: 1.00, alpha: 1).cgColor
let amber = NSColor(srgbRed: 1.00, green: 0.77, blue: 0.39, alpha: 1).cgColor
let red = NSColor(srgbRed: 1.00, green: 0.43, blue: 0.47, alpha: 1).cgColor
func alpha(_ color: CGColor, _ value: Double) -> CGColor { color.copy(alpha: value)! }
func clamp(_ x: Double) -> Double { max(0, min(1, x)) }
func ease(_ x: Double) -> Double { let p = clamp(x); return p * p * (3 - 2*p) }
func lerp(_ a: Double, _ b: Double, _ p: Double) -> Double { a + (b-a)*p }
var c: CGContext!
var fontCache: [String: CTFont] = [:]
func font(_ size: Double, _ mono: Bool, _ bold: Bool) -> CTFont {
    let key = "\(size)-\(mono)-\(bold)"
    if let f = fontCache[key] { return f }
    let name = mono ? (bold ? "Menlo-Bold" : "Menlo-Regular") : (bold ? "HelveticaNeue-Bold" : "HelveticaNeue")
    let f = CTFontCreateWithName(name as CFString, size, nil)
    fontCache[key] = f
    return f
}
func line(_ s: String, size: Double, color: CGColor, mono: Bool = false, bold: Bool = false) -> CTLine {
    CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font(size, mono, bold),
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color
    ]))
}
func measure(_ s: String, size: Double, mono: Bool = false, bold: Bool = false) -> Double {
    CTLineGetTypographicBounds(line(s, size: size, color: white, mono: mono, bold: bold), nil, nil, nil)
}
func text(_ s: String, _ x: Double, _ y: Double, _ size: Double = 28, _ color: CGColor = white, bold: Bool = false, mono: Bool = false, align: String = "left") {
    let l = line(s, size: size, color: color, mono: mono, bold: bold)
    let width = CTLineGetTypographicBounds(l, nil, nil, nil)
    let dx = align == "center" ? -width/2 : (align == "right" ? -width : 0)
    c.saveGState(); c.textMatrix = .identity
    c.translateBy(x: x+dx, y: y+size*0.84); c.scaleBy(x: 1, y: -1)
    c.textPosition = .zero; CTLineDraw(l, c); c.restoreGState()
}
func wrapped(_ s: String, _ x: Double, _ y: Double, _ width: Double, _ size: Double = 28, _ color: CGColor = white, bold: Bool = false, lineHeight: Double? = nil, align: String = "left") {
    var lines: [String] = []; var current = ""
    for word in s.split(whereSeparator: { $0.isWhitespace }) {
        let trial = current.isEmpty ? String(word) : current + " " + word
        if measure(trial, size: size, bold: bold) > width && !current.isEmpty { lines.append(current); current = String(word) } else { current = trial }
    }
    if !current.isEmpty { lines.append(current) }
    for (i,l) in lines.enumerated() { text(l, x, y+Double(i)*(lineHeight ?? size*1.35), size, color, bold: bold, align: align) }
}
func box(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ fill: CGColor = panel, stroke: CGColor? = border, radius: Double = 22) {
    let r = CGRect(x:x,y:y,width:w,height:h)
    let p = CGPath(roundedRect:r, cornerWidth:radius, cornerHeight:radius, transform:nil)
    c.addPath(p); c.setFillColor(fill); c.fillPath()
    if let stroke = stroke { c.addPath(p); c.setStrokeColor(stroke); c.setLineWidth(1.4); c.strokePath() }
}
func path(_ pts: [CGPoint], _ color: CGColor = border, width: Double = 3, progress: Double = 1, dashed: Bool = false) {
    guard pts.count > 1 else { return }
    var lengths: [Double] = []; var total = 0.0
    for i in 1..<pts.count { let d = hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y); lengths.append(d); total += d }
    var remain = total * clamp(progress)
    c.saveGState(); c.setStrokeColor(color); c.setLineWidth(width); c.setLineCap(.round); c.setLineJoin(.round)
    if dashed { c.setLineDash(phase:0,lengths:[7,8]) }
    c.beginPath(); c.move(to:pts[0])
    for i in 1..<pts.count {
        let d = lengths[i-1]
        if remain >= d { c.addLine(to:pts[i]); remain -= d }
        else { let q = d > 0 ? remain/d : 0; c.addLine(to:CGPoint(x:lerp(pts[i-1].x,pts[i].x,q),y:lerp(pts[i-1].y,pts[i].y,q))); break }
    }
    c.strokePath(); c.restoreGState()
}
func arrow(_ x1:Double,_ y1:Double,_ x2:Double,_ y2:Double,_ color:CGColor = secondary, p:Double = 1) {
    path([CGPoint(x:x1,y:y1),CGPoint(x:x2,y:y2)],color,width:2.5,progress:p)
    if p > 0.97 {
        let a = atan2(y2-y1,x2-x1), s = 10.0
        path([CGPoint(x:x2-s*cos(a-0.5),y:y2-s*sin(a-0.5)),CGPoint(x:x2,y:y2),CGPoint(x:x2-s*cos(a+0.5),y:y2-s*sin(a+0.5))],color,width:2.5)
    }
}
func dot(_ x:Double,_ y:Double,_ radius:Double,_ color:CGColor) { c.setFillColor(color); c.fillEllipse(in:CGRect(x:x-radius,y:y-radius,width:2*radius,height:2*radius)) }
func pulse(_ x1:Double,_ y1:Double,_ x2:Double,_ y2:Double,_ time:Double,_ start:Double,_ duration:Double,_ color:CGColor = teal) {
    let p = (time-start)/duration
    guard p >= 0 && p <= 1 else { return }
    let e = ease(p); let x = lerp(x1,x2,e), y = lerp(y1,y2,e)
    dot(x,y,18,alpha(color,0.08)); dot(x,y,10,alpha(color,0.20)); dot(x,y,5,color)
}
func reveal(_ time:Double,_ at:Double,_ body:()->Void) {
    let p = ease((time-at)/0.65); guard p > 0 else { return }
    c.saveGState(); c.setAlpha(p); c.translateBy(x:0,y:18*(1-p)); body(); c.restoreGState()
}
func check(_ x:Double,_ y:Double,_ color:CGColor = teal,_ size:Double = 20) {
    path([CGPoint(x:x-size*0.4,y:y),CGPoint(x:x-size*0.1,y:y+size*0.3),CGPoint(x:x+size*0.5,y:y-size*0.4)],color,width:3.3)
}
func cross(_ x:Double,_ y:Double,_ color:CGColor = red,_ size:Double = 18) {
    path([CGPoint(x:x-size/2,y:y-size/2),CGPoint(x:x+size/2,y:y+size/2)],color,width:3)
    path([CGPoint(x:x+size/2,y:y-size/2),CGPoint(x:x-size/2,y:y+size/2)],color,width:3)
}
func lock(_ x:Double,_ y:Double,_ color:CGColor = amber,_ scale:Double = 1) {
    c.saveGState(); c.translateBy(x:x,y:y); c.scaleBy(x:scale,y:scale)
    let p = CGMutablePath(); p.move(to:CGPoint(x:-10,y:-1)); p.addLine(to:CGPoint(x:-10,y:-10)); p.addCurve(to:CGPoint(x:10,y:-10),control1:CGPoint(x:-10,y:-25),control2:CGPoint(x:10,y:-25)); p.addLine(to:CGPoint(x:10,y:-1))
    c.addPath(p); c.setStrokeColor(color); c.setLineWidth(3); c.strokePath()
    box(-17,-2,34,29,alpha(color,0.13),stroke:color,radius:5); dot(0,10,3,color); c.restoreGState()
}
func icon(_ name:String,_ x:Double,_ y:Double,_ color:CGColor,_ scale:Double = 1) {
    c.saveGState(); c.translateBy(x:x,y:y); c.scaleBy(x:scale,y:scale)
    switch name {
    case "agent":
        box(-27,-21,54,42,alpha(color,0.09),stroke:color,radius:12)
        dot(-10,-2,4,color); dot(10,-2,4,color)
        path([CGPoint(x:-10,y:11),CGPoint(x:10,y:11)],color,width:2.5)
        path([CGPoint(x:0,y:-22),CGPoint(x:0,y:-32)],color,width:2.5); dot(0,-34,3,color)
    case "compiler":
        path([CGPoint(x:-12,y:-22),CGPoint(x:-29,y:0),CGPoint(x:-12,y:22)],color,width:3.5)
        path([CGPoint(x:12,y:-22),CGPoint(x:29,y:0),CGPoint(x:12,y:22)],color,width:3.5)
        path([CGPoint(x:6,y:-25),CGPoint(x:-6,y:25)],color,width:3)
    case "policy":
        let p = CGMutablePath(); p.move(to:CGPoint(x:0,y:-29)); p.addLine(to:CGPoint(x:26,y:-18)); p.addLine(to:CGPoint(x:23,y:8)); p.addQuadCurve(to:CGPoint(x:0,y:31),control:CGPoint(x:19,y:23)); p.addQuadCurve(to:CGPoint(x:-23,y:8),control:CGPoint(x:-19,y:23)); p.addLine(to:CGPoint(x:-26,y:-18)); p.closeSubpath()
        c.addPath(p); c.setFillColor(alpha(color,0.1)); c.fillPath(); c.addPath(p); c.setStrokeColor(color); c.setLineWidth(2.5); c.strokePath(); check(0,1,color,23)
    case "broker":
        box(-28,-28,56,56,alpha(color,0.08),stroke:color,radius:9)
        c.setStrokeColor(color); c.setLineWidth(2); c.strokeEllipse(in:CGRect(x:-14,y:-14,width:28,height:28))
        path([CGPoint(x:-9,y:-9),CGPoint(x:9,y:9)],color,width:2); path([CGPoint(x:9,y:-9),CGPoint(x:-9,y:9)],color,width:2)
    case "provider":
        box(-29,-24,58,48,alpha(color,0.08),stroke:color,radius:6)
        path([CGPoint(x:-18,y:-10),CGPoint(x:18,y:-10)],color,width:2)
        path([CGPoint(x:-18,y:0),CGPoint(x:10,y:0)],color,width:2)
        path([CGPoint(x:-18,y:10),CGPoint(x:15,y:10)],color,width:2)
    case "owner":
        c.setStrokeColor(color); c.setLineWidth(2.5); c.strokeEllipse(in:CGRect(x:-11,y:-27,width:22,height:22))
        let p = CGMutablePath(); p.move(to:CGPoint(x:-24,y:23)); p.addCurve(to:CGPoint(x:24,y:23),control1:CGPoint(x:-24,y:-8),control2:CGPoint(x:24,y:-8)); c.addPath(p); c.strokePath()
    default: break
    }
    c.restoreGState()
}
func pill(_ label:String,_ x:Double,_ y:Double,_ color:CGColor = teal,_ size:Double = 20) {
    let width = measure(label,size:size,mono:true)+32
    box(x,y,width,38,alpha(color,0.09),stroke:alpha(color,0.25),radius:19); text(label,x+16,y+8,size,color,mono:true)
}
// A compiler's own outbound call passes the egress proxy (ISOLATE-01), shown quietly on the
// arrow before the egress chapter explains it. Drawn over the arrow and its pulse.
func proxyChip(_ cx:Double,_ cy:Double,_ time:Double,_ at:Double) {
    let p = ease((time-at)/0.5); guard p > 0 else { return }
    let w = measure("egress proxy",size:15,mono:true)+22, h = 24.0
    c.saveGState(); c.setAlpha(p)
    box(cx-w/2,cy-h/2,w,h,bg,stroke:alpha(secondary,0.4),radius:8)
    text("egress proxy",cx-w/2+11,cy-9,15,alpha(secondary,0.9),mono:true)
    c.restoreGState()
}
func actor(_ name:String,_ kind:String,_ detail:String,_ x:Double,_ y:Double,_ w:Double,_ h:Double,_ color:CGColor) {
    box(x,y,w,h); icon(kind,x+48,y+55,color,0.8); text(name,x+86,y+37,30,white,bold:true)
    if !detail.isEmpty { wrapped(detail,x+28,y+102,w-56,24,secondary,lineHeight:33) }
}

func scene0(_ t:Double) {
    reveal(t,0.1) {
        actor("Client agent","agent","Writes a program",100,390,330,270,blue)
        pill("program + user identity",124,580,blue,17)
    }
    reveal(t,0.8) {
        actor("Gateway","policy","Verifies identity\n",515,425,285,200,blue)
        text("Routes the request",543,567,23,secondary)
    }
    arrow(430,520,515,520,blue,p:ease((t-1)/0.8)); pulse(430,520,515,520,t,1.5,1,blue)
    reveal(t,1.7) {
        box(895,325,925,405); icon("compiler",944,380,teal,0.85); text("Compiler",989,361,34,white,bold:true)
        text("L0176",1768,369,22,secondary,mono:true,align:"right")
        box(927,430,390,245,alpha(white,0.025),stroke:nil,radius:12)
        text("ORDINARY COMPUTATION",951,451,19,secondary,bold:true)
        text("build items",951,501,24,white,mono:true); text("transform data",951,544,24,white,mono:true)
        check(965,627,teal); text("Runs without a grant",990,610,22,secondary)
        box(1340,430,447,245,alpha(amber,0.055),stroke:alpha(amber,0.25),radius:12)
        text("PROTECTED FUNCTIONS",1365,451,19,amber,bold:true)
        text("init",1365,501,25,white,mono:true); text("preview signing",1457,506,20,secondary)
        text("save-to-itembank",1365,549,24,white,mono:true)
        lock(1380,628,amber,0.6); text("Requires permission",1406,611,22,amber)
    }
    arrow(800,520,895,520,blue,p:ease((t-2.2)/0.8)); pulse(800,520,895,520,t,2.8,1,blue)
    reveal(t,5.2) { text("A function name is a request for authority — it does not grant authority.",960,768,27,secondary,align:"center") }
}
func scene1(_ t:Double) {
    reveal(t,0.1) { actor("Connection owner","owner","Chooses who may use\nthe connection",100,365,405,260,blue) }
    reveal(t,0.8) {
        box(660,325,640,420,alpha(purple,0.055),stroke:alpha(purple,0.35))
        icon("policy",708,381,purple,0.75); text("Policy stores the grant",752,361,31,white,bold:true)
        let fields = [("recipient","verified user"),("connection","item-bank connection"),("language","L0176"),("function","save-to-itembank"),("expiry","optional deadline")]
        for (i,row) in fields.enumerated() { let y = 440+Double(i)*51; text(row.0,691,y,21,secondary,mono:true); text(row.1,883,y,23,i == 3 ? teal : white,mono:true) }
    }
    arrow(505,486,660,486,purple,p:ease((t-1.2)/1)); pulse(505,486,660,486,t,2.2,1.2,purple)
    reveal(t,2.6) {
        actor("Broker","broker","Sole runtime custodian\nof provider credentials",1450,365,370,340,amber)
        lock(1497,628,amber,0.7); text("credential encrypted",1530,614,19,amber,mono:true)
    }
    reveal(t,4.5) { pill("EXACT LANGUAGE + FUNCTION",675,770,purple,19); pill("NO ONWARD DELEGATION",1100,770,secondary,19) }
    reveal(t,6) { text("Sharing the connection delegates an action; it never hands the secret to the agent.",960,284,25,secondary,align:"center") }
}
func scene2(_ t:Double) {
    let lastDenied = t >= 4.3
    reveal(t,0.1) { actor("Gateway","policy","Collects the manifests",100,385,330,225,blue) }
    let xs = [565.0,1000.0,1435.0]
    let names = ["Stage 1","Stage 2","Stage 3"]
    let fns = ["pure transform","init","save-to-itembank"]
    for i in 0..<3 {
        reveal(t,0.6+Double(i)*0.65) {
            box(xs[i],345,385,235); text(names[i],xs[i]+28,375,27,white,bold:true)
            text("compiler manifest",xs[i]+28,422,21,secondary)
            text(fns[i],xs[i]+28,472,i == 2 ? 24 : 26,i == 0 ? secondary : teal,mono:true)
            text("not executing",xs[i]+28,526,20,secondary)
        }
    }
    arrow(430,461,565,461,blue,p:ease((t-0.6)/0.7))
    for i in 0..<2 { arrow(xs[i]+385,461,xs[i+1],461,border,p:ease((t-1.1-Double(i)*0.6)/0.6)) }
    reveal(t,2.5) {
        box(565,675,1255,115,alpha(purple,0.055),stroke:alpha(purple,0.3),radius:18)
        icon("policy",616,732,purple,0.65); text("Policy",658,706,29,white,bold:true)
        text("One decision for the complete chain",800,714,25,secondary)
    }
    for i in 0..<3 {
        let cx = xs[i]+192.5
        arrow(cx,580,cx,675,purple,p:ease((t-2.8-Double(i)*0.25)/0.6))
        pulse(cx,580,cx,675,t,3.3+Double(i)*0.2,0.7,purple)
    }
    if lastDenied {
        reveal(t,4.3) {
            cross(1758,389,red,22); pill("DENIED",1625,526,red,18)
            box(1245,697,545,70,alpha(red,0.1),stroke:nil,radius:10)
            cross(1280,733,red,22); text("CHAIN BLOCKED · zero stage execution",1308,717,21,red)
        }
    }
    reveal(t,6.6) { text("Every stage must pass. The approved plan pins compiler revisions and program digests.",960,284,25,secondary,align:"center") }
}
func scene3(_ t:Double) {
    reveal(t,0.1) {
        actor("Compiler","compiler","Reaches a protected call",100,345,425,390,teal)
        box(126,527,373,157,alpha(teal,0.06),stroke:alpha(teal,0.25),radius:12)
        text("save-to-itembank",147,552,25,teal,mono:true); text("payload: { items: … }",147,605,22,white,mono:true)
        text("admitted stage + session",126,697,18,secondary,mono:true)
    }
    reveal(t,0.8) { actor("Policy","policy","Re-checks the grant",710,325,485,190,purple) }
    arrow(525,433,710,433,purple,p:ease((t-1)/0.7)); pulse(525,433,710,433,t,1.7,0.8,purple)
    proxyChip(617,433,t,1.3)
    reveal(t,2.1) {
        box(658,565,590,210,alpha(teal,0.075),stroke:alpha(teal,0.5),radius:17)
        text("EXECUTION CAPABILITY",685,588,20,teal,bold:true)
        text("function + operation + args digest",685,632,22,white,mono:true)
        text("user + connection + plan + stage",685,669,22,white,mono:true)
        pill("≤ 60 seconds",685,717,teal,17); pill("single use",934,717,teal,17)
    }
    arrow(950,515,950,565,teal,p:ease((t-2.1)/0.6)); pulse(950,515,950,565,t,2.7,0.7,teal)
    reveal(t,3.6) {
        actor("Broker","broker","Verifies token + payload",1425,375,395,300,amber)
        pill("registered operation only",1450,592,amber,17)
    }
    // The minted proof returns to the compiler, which presents it to Broker.
    arrow(658,668,525,668,teal,p:ease((t-3.5)/0.7))
    pulse(658,668,525,668,t,3.6,0.7,teal)
    path([CGPoint(x:312,y:735),CGPoint(x:312,y:790),CGPoint(x:1360,y:790),CGPoint(x:1360,y:525),CGPoint(x:1425,y:525)],teal,width:2.5,progress:ease((t-4.4)/2))
    if t > 6.4 { arrow(1360,525,1425,525,teal) }
    proxyChip(1240,790,t,5.6)
    reveal(t,6.1) { text("Compiler presents capability + exact payload",650,803,22,teal) }
    reveal(t,7.4) { text("Changing the arguments breaks the binding.",1480,725,23,secondary,align:"center") }
}
func scene4(_ t:Double) {
    reveal(t,0.1) {
        actor("Compiler","compiler","Capability + payload",100,470,350,235,teal)
        actor("Broker","broker","Verify · consume token ID",675,430,470,310,amber)
        lock(720,641,amber,0.65); text("Load bound credential",753,627,23,amber)
        text("claim receipt before a write",700,696,21,secondary)
    }
    arrow(450,565,675,565,teal,p:ease((t-0.7)/0.7)); pulse(450,565,675,565,t,1.4,0.8,teal)
    proxyChip(562,565,t,0.9)
    reveal(t,1.7) {
        box(675,280,470,110,alpha(purple,0.07),stroke:alpha(purple,0.3),radius:16)
        icon("policy",719,335,purple,0.6); text("Policy · live state",760,313,29,white,bold:true)
    }
    arrow(880,430,880,390,purple,p:ease((t-2.3)/0.5))
    arrow(955,390,955,430,purple,p:ease((t-2.9)/0.5))
    reveal(t,3.3) {
        actor("Provider","provider","Perform constrained operation",1450,350,370,210,teal)
        pill("ACTIVE → ALLOW",1190,376,teal,17)
    }
    arrow(1145,491,1450,491,teal,p:ease((t-3.8)/0.8)); pulse(1145,491,1450,491,t,4.6,0.8,teal)
    reveal(t,5.1) {
        box(1450,641,370,125,alpha(red,0.07),stroke:alpha(red,0.3),radius:16)
        cross(1484,685,red,24); text("Next effect blocked",1515,667,25,red,bold:true)
        text("Revoked or unavailable",1476,718,22,secondary)
        path([CGPoint(x:1145,y:618),CGPoint(x:1270,y:618),CGPoint(x:1270,y:704),CGPoint(x:1450,y:704)],red,width:2.5,progress:ease((t-5.1)/0.7))
        pill("REVOKED → DENY",1170,727,red,17)
    }
    reveal(t,7.7) { text("A fresh decision before every provider step, signature, or receipt replay.",960,801,25,secondary,align:"center") }
}
// ISOLATE-01: compilers reach the outside only through the egress proxy.
func sceneEgress(_ t:Double) {
    reveal(t,0.1) {
        actor("Compiler","compiler","Compromised dependency",100,400,330,230,teal)
        pill("ISOLATE-01 · not yet deployed",100,322,amber,16)
    }
    reveal(t,0.8) {
        box(560,365,430,300,alpha(blue,0.06),stroke:alpha(blue,0.4))
        text("Egress proxy",590,392,31,white,bold:true)
        text("Envoy · internal load balancer",590,437,21,secondary)
        text("reviewed allowlist per compiler",590,490,19,white,mono:true)
        text("host = SNI = CONNECT target",590,527,19,white,mono:true)
        text("internal addresses refused",590,564,19,white,mono:true)
        text("every request logged",590,601,19,white,mono:true)
    }
    arrow(430,515,560,515,teal,p:ease((t-1.2)/0.6))
    let rows: [(String,String,Bool,Double)] = [
        ("Policy · Broker","listed Graffiticode hosts",true,2.0),
        ("Learnosity","direct, around Broker",false,3.4),
        ("Attacker host","any unlisted host",false,4.4),
        ("Metadata · private IPs","by name or by address",false,5.4),
    ]
    for (i,row) in rows.enumerated() {
        let y = 320+Double(i)*112
        reveal(t,row.3) {
            box(1225,y,595,90,alpha(row.2 ? teal : red,0.06),stroke:alpha(row.2 ? teal : red,0.3),radius:14)
            text(row.0,1300,y+16,26,white,bold:true); text(row.1,1300,y+52,20,secondary)
            if row.2 { check(1262,y+45,teal,24) } else { cross(1262,y+45,red,22) }
        }
        let color = row.2 ? teal : red
        arrow(990,515,1225,y+45,color,p:ease((t-row.3-0.1)/0.6))
        if row.2 { pulse(990,515,1225,y+45,t,row.3+0.3,0.8,teal) }
    }
    reveal(t,6.6) {
        path([CGPoint(x:265,y:630),CGPoint(x:265,y:770)],teal,width:2.5,dashed:true)
        text("Identity tokens: metadata server, direct",290,742,21,teal)
        pill("DNS locked down",1225,770,secondary,17); pill("L0185: public hosts only",1225+measure("DNS locked down",size:17,mono:true)+52,770,secondary,17)
    }
}
func scene5(_ t:Double) {
    let fade = 1-ease((t-7.4)/0.7)
    c.saveGState(); c.setAlpha(fade); c.beginTransparencyLayer(auxiliaryInfo:nil)
    reveal(t,0.1) { actor("Provider","provider","Reports the outcome",100,385,380,245,teal) }
    reveal(t,0.8) {
        box(680,320,575,435,alpha(teal,0.045),stroke:alpha(teal,0.35))
        text("DURABLE RECEIPT",710,348,22,teal,bold:true)
        text("Broker",710,397,33,white,bold:true)
        text("operation ID",710,455,20,secondary,mono:true)
        text("invocation / stage / call",710,494,25,white,mono:true)
        path([CGPoint(x:710,y:546),CGPoint(x:1225,y:546)],border,width:1)
        check(726,587,teal,22); text("Claimed before dispatch",751,570,25,white)
        check(726,638,teal,22); text("Step outcomes preserved",751,621,25,white)
        check(726,689,teal,22); text("Retry returns the receipt",751,672,25,white)
    }
    arrow(480,500,680,500,teal,p:ease((t-1.6)/0.8)); pulse(480,500,680,500,t,2.1,0.8,teal)
    reveal(t,2.2) { actor("Client agent","agent","Receives result + receipt",1460,385,360,245,blue) }
    arrow(1255,500,1460,500,blue,p:ease((t-2.6)/0.8)); pulse(1255,500,1460,500,t,3.1,0.8,blue)
    path([CGPoint(x:1635,y:630),CGPoint(x:1635,y:788),CGPoint(x:980,y:788),CGPoint(x:980,y:755)],blue,width:2,progress:ease((t-4.1)/1),dashed:true)
    reveal(t,4.6) { text("Same operation ID · fresh token · live authorization",1290,802,21,blue,align:"center") }
    reveal(t,6.0) { pill("success / failed / partial / uncertain",100,670,secondary,16) }
    c.endTransparencyLayer(); c.restoreGState()
    reveal(t,7.8) {
        icon("agent",350,470,blue,1.5); icon("broker",1570,470,amber,1.5)
        text("The agent gets the result.",960,390,62,white,bold:true,align:"center")
        text("The credential stays in Broker.",960,490,56,teal,bold:true,align:"center")
        text("Scoped grants  /  Protected functions  /  Brokered effects  /  Contained egress",960,650,27,secondary,align:"center")
    }
}

func draw(_ time:Double,_ ctx:CGContext) {
    c = ctx; c.saveGState(); c.translateBy(x:0,y:Double(H)); c.scaleBy(x:1,y:-1)
    c.setFillColor(bg); c.fill(CGRect(x:0,y:0,width:W,height:H))
    // A quiet grid and a restrained glow keep the moving signals legible.
    let cs = CGColorSpaceCreateDeviceRGB()
    let gradient = CGGradient(colorsSpace:cs,colors:[alpha(teal,0.065),alpha(teal,0)] as CFArray,locations:[0,1])!
    c.drawRadialGradient(gradient,startCenter:CGPoint(x:1600,y:350),startRadius:0,endCenter:CGPoint(x:1600,y:350),endRadius:950,options:[])
    for x in stride(from:80,through:1840,by:40) { for y in stride(from:290,through:810,by:40) { dot(Double(x),Double(y),0.8,alpha(secondary,0.14)) } }
    dot(108,76,8,teal); text("GRAFFITICODE",129,60,23,white,bold:true)
    text("CAPABILITY SECURITY",350,63,20,secondary)
    text("\(DURATION) SECOND EXPLAINER",1818,63,19,secondary,mono:true,align:"right")
    let sceneIndex = min(N-1,Int(time/10)); let t = time-Double(sceneIndex)*10
    let scene = scenes[sceneIndex]
    let fade = min(ease(t/0.45),sceneIndex == N-1 ? 1 : ease((10-t)/0.35))
    c.saveGState(); c.setAlpha(fade); c.beginTransparencyLayer(auxiliaryInfo:nil)
    text(String(format:"%02d / %02d",sceneIndex+1,N),100,135,19,teal,mono:true)
    text(scene["title"] as! String,100,177,57,white,bold:true)
    text(scene["subtitle"] as! String,100,252,27,secondary)
    switch scene["scene"] as! String {
    case "request": scene0(t); case "grant": scene1(t); case "admission": scene2(t)
    case "capability": scene3(t); case "live": scene4(t); case "egress": sceneEgress(t); default: scene5(t)
    }
    c.endTransparencyLayer(); c.restoreGState()
    // Burned-in captions match the narration, with an accompanying WebVTT track.
    path([CGPoint(x:100,y:855),CGPoint(x:1820,y:855)],alpha(border,0.75),width:1)
    wrapped(scene["narration"] as! String,960,879,1660,29,white,lineHeight:40,align:"center")
    let segment = (1720-Double(N-1)*25)/Double(N)
    for i in 0..<N {
        let x = 100+Double(i)*(segment+25)
        box(x,1003,segment,4,alpha(secondary,0.15),stroke:nil,radius:2)
        let p = clamp((time-Double(i)*10)/10)
        if p > 0 { box(x,1003,max(4,segment*p),4,teal,stroke:nil,radius:2) }
        text(scenes[i]["chapter"] as! String,x,1024,19,i == sceneIndex ? white : secondary)
    }
    let shown = min(DURATION-1,Int(time))
    text(String(format:"%02d:%02d / %02d:%02d",shown/60,shown%60,DURATION/60,DURATION%60),1820,135,17,secondary,mono:true,align:"right")
    c.restoreGState()
}

func savePNG(_ time:Double,_ path:URL) throws {
    let ctx = CGContext(data:nil,width:W,height:H,bitsPerComponent:8,bytesPerRow:W*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
    draw(time,ctx)
    let dest = CGImageDestinationCreateWithURL(path as CFURL,UTType.png.identifier as CFString,1,nil)!
    CGImageDestinationAddImage(dest,ctx.makeImage()!,nil)
    if !CGImageDestinationFinalize(dest) { throw NSError(domain:"PNG",code:1) }
}
func waitExport(_ export:AVAssetExportSession) throws {
    let sem = DispatchSemaphore(value:0)
    export.exportAsynchronously { sem.signal() }
    sem.wait()
    if export.status != .completed { throw export.error ?? NSError(domain:"Export",code:1) }
}
func removeGenerated(_ path:URL) { if fm.fileExists(atPath:path.path) { try? fm.removeItem(at:path) } }

let frames = (0..<N).map { Double($0)*10+6.5 } + [Double(DURATION)-0.7]
if mode == "preview" {
    for (i,t) in frames.enumerated() {
        try savePNG(t,scratch.appendingPathComponent("preview-\(i+1).png"))
    }
    try savePNG(6,output.appendingPathComponent("poster.png"))
    print("Rendered \(frames.count) 1920×1080 preview frames.")
} else if mode == "video" {
    let videoURL = scratch.appendingPathComponent("silent.mp4")
    removeGenerated(videoURL)
    let writer = try AVAssetWriter(outputURL:videoURL,fileType:.mp4)
    let input = AVAssetWriterInput(mediaType:.video,outputSettings:[
        AVVideoCodecKey:AVVideoCodecType.h264,
        AVVideoWidthKey:W,AVVideoHeightKey:H,
        AVVideoCompressionPropertiesKey:[
            AVVideoAverageBitRateKey:6_000_000,
            AVVideoExpectedSourceFrameRateKey:FPS,
            AVVideoMaxKeyFrameIntervalKey:FPS*2,
            AVVideoProfileLevelKey:AVVideoProfileLevelH264HighAutoLevel
        ]
    ])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:[
        kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32ARGB,
        kCVPixelBufferWidthKey as String:W,kCVPixelBufferHeightKey as String:H,
        kCVPixelBufferCGImageCompatibilityKey as String:true,kCVPixelBufferCGBitmapContextCompatibilityKey as String:true
    ])
    writer.add(input)
    guard writer.startWriting() else { throw writer.error! }
    writer.startSession(atSourceTime:.zero)
    for frame in 0..<(DURATION*FPS) {
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed { throw writer.error! }
            Thread.sleep(forTimeInterval:0.004)
        }
        try autoreleasepool {
            var pixel:CVPixelBuffer?
            let status = CVPixelBufferPoolCreatePixelBuffer(nil,adaptor.pixelBufferPool!,&pixel)
            guard status == kCVReturnSuccess,let pixel = pixel else { throw NSError(domain:"PixelBuffer",code:Int(status)) }
            CVPixelBufferLockBaseAddress(pixel,[])
            let ctx = CGContext(data:CVPixelBufferGetBaseAddress(pixel),width:W,height:H,bitsPerComponent:8,bytesPerRow:CVPixelBufferGetBytesPerRow(pixel),space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipFirst.rawValue)!
            draw(Double(frame)/Double(FPS),ctx)
            CVPixelBufferUnlockBaseAddress(pixel,[])
            guard adaptor.append(pixel,withPresentationTime:CMTime(value:Int64(frame),timescale:Int32(FPS))) else { throw writer.error ?? NSError(domain:"Append",code:1) }
        }
        if frame % 150 == 0 { print("Video \(frame/FPS)/\(DURATION) s"); fflush(stdout) }
    }
    writer.endSession(atSourceTime:CMTime(seconds:Double(DURATION),preferredTimescale:600))
    input.markAsFinished()
    let sem = DispatchSemaphore(value:0); writer.finishWriting { sem.signal() }; sem.wait()
    guard writer.status == .completed else { throw writer.error! }
    print("Video rendered. Assembling narration."); fflush(stdout)
    let audioComposition = AVMutableComposition()
    let audioTrack = audioComposition.addMutableTrack(withMediaType:.audio,preferredTrackID:kCMPersistentTrackID_Invalid)!
    for i in 0..<N {
        let audio = AVURLAsset(url:scratch.appendingPathComponent("scene-\(i).aiff"))
        let duration = CMTimeGetSeconds(audio.duration)
        guard duration > 0 else { throw NSError(domain:"Empty narration scene \(i)",code:1) }
        guard duration < 9.5 else { throw NSError(domain:"Narration scene \(i) exceeds 9.5 s (\(duration))",code:1) }
        try audioTrack.insertTimeRange(CMTimeRange(start:.zero,duration:audio.duration),of:audio.tracks(withMediaType:.audio)[0],at:CMTime(seconds:Double(i)*10+0.45,preferredTimescale:600))
        print("Narration \(i+1): \(String(format:"%.2f",duration)) s")
    }
    let audioURL = scratch.appendingPathComponent("narration.m4a"); removeGenerated(audioURL)
    let audioExport = AVAssetExportSession(asset:audioComposition,presetName:AVAssetExportPresetAppleM4A)!
    audioExport.outputURL = audioURL; audioExport.outputFileType = .m4a
    try waitExport(audioExport)
    let composition = AVMutableComposition()
    let video = AVURLAsset(url:videoURL), audio = AVURLAsset(url:audioURL)
    let videoTrack = composition.addMutableTrack(withMediaType:.video,preferredTrackID:kCMPersistentTrackID_Invalid)!
    try videoTrack.insertTimeRange(CMTimeRange(start:.zero,duration:CMTime(seconds:Double(DURATION),preferredTimescale:600)),of:video.tracks(withMediaType:.video)[0],at:.zero)
    let finalAudio = composition.addMutableTrack(withMediaType:.audio,preferredTrackID:kCMPersistentTrackID_Invalid)!
    try finalAudio.insertTimeRange(CMTimeRange(start:.zero,duration:audio.duration),of:audio.tracks(withMediaType:.audio)[0],at:.zero)
    let finalURL = output.appendingPathComponent(FILE); removeGenerated(finalURL)
    let export = AVAssetExportSession(asset:composition,presetName:AVAssetExportPresetPassthrough)!
    export.outputURL = finalURL; export.outputFileType = .mp4; export.shouldOptimizeForNetworkUse = true
    let title = AVMutableMetadataItem(); title.identifier = .commonIdentifierTitle; title.value = TITLE as NSString
    let description = AVMutableMetadataItem(); description.identifier = .commonIdentifierDescription; description.value = "Client agent, compiler protected functions, scoped grants, chain admission, single-use capabilities, live Policy checks, Broker credential custody, compiler egress through the ISOLATE-01 proxy, and durable receipts." as NSString
    export.metadata = [title,description]
    try waitExport(export)
    print("Exported \(finalURL.path)")
} else if mode == "verify" {
    let url = output.appendingPathComponent(FILE)
    let asset = AVURLAsset(url:url)
    let duration = CMTimeGetSeconds(asset.duration)
    let video = asset.tracks(withMediaType:.video)[0]
    let audio = asset.tracks(withMediaType:.audio)[0]
    print("Duration: \(duration) seconds; size: \(video.naturalSize); fps: \(video.nominalFrameRate); audio: \(CMTimeGetSeconds(audio.timeRange.duration)) seconds")
    guard abs(duration-Double(DURATION)) < 0.04, video.naturalSize.width == 1920, video.naturalSize.height == 1080, video.nominalFrameRate == 30 else { throw NSError(domain:"Video verification",code:1) }
    let reader = try AVAssetReader(asset:asset)
    let trackOut = AVAssetReaderTrackOutput(track:video,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA])
    reader.add(trackOut); reader.startReading()
    var count = 0
    while let sample = trackOut.copyNextSampleBuffer() { count += 1; if CMSampleBufferGetNumSamples(sample) != 1 { throw NSError(domain:"Unexpected sample",code:1) } }
    guard reader.status == .completed, count == DURATION*FPS else { throw reader.error ?? NSError(domain:"Frame count \(count)",code:1) }
    print("Decoded all \(count) video frames successfully.")
    let ar = try AVAssetReader(asset:asset)
    let ao = AVAssetReaderTrackOutput(track:audio,outputSettings:[AVFormatIDKey:kAudioFormatLinearPCM,AVLinearPCMIsFloatKey:true,AVLinearPCMBitDepthKey:32])
    ar.add(ao); ar.startReading(); var peak:Float = 0; var samples = 0
    while let sample = ao.copyNextSampleBuffer() {
        if let buffer = CMSampleBufferGetDataBuffer(sample) {
            var length = 0; var pointer:UnsafeMutablePointer<Int8>?
            CMBlockBufferGetDataPointer(buffer,atOffset:0,lengthAtOffsetOut:nil,totalLengthOut:&length,dataPointerOut:&pointer)
            if let pointer = pointer {
                pointer.withMemoryRebound(to:Float.self,capacity:length/4) { floats in
                    for i in 0..<(length/4) { peak = max(peak,abs(floats[i])); samples += 1 }
                }
            }
        }
    }
    guard ar.status == .completed, peak > 0.02 else { throw ar.error ?? NSError(domain:"Silent audio",code:1) }
    print("Decoded \(samples) narration samples; peak \(peak).")
    let generator = AVAssetImageGenerator(asset:asset); generator.appliesPreferredTrackTransform = true
    for (i,time) in frames.enumerated() {
        let img = try generator.copyCGImage(at:CMTime(seconds:time,preferredTimescale:600),actualTime:nil)
        let dest = CGImageDestinationCreateWithURL(scratch.appendingPathComponent("verified-\(i+1).png") as CFURL,UTType.png.identifier as CFString,1,nil)!
        CGImageDestinationAddImage(dest,img,nil); CGImageDestinationFinalize(dest)
    }
    print("Extracted \(frames.count) verification frames from the final MP4.")
}
