// Usage: ocr <image> -> JSON lines {text, conf, box:[x,y,w,h]} in image pixels (origin top-left).
import Foundation
import Vision
import AppKit

let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot read \(path)\n".data(using: .utf8)!); exit(1)
}
let W = Double(cg.width), H = Double(cg.height)
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
req.minimumTextHeight = 0.002
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([req])
var out: [[String: Any]] = []
for obs in (req.results ?? []) {
  guard let c = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox
  out.append(["text": c.string, "conf": c.confidence, "box": [b.minX * W, (1 - b.maxY) * H, b.width * W, b.height * H]])
}
let data = try JSONSerialization.data(withJSONObject: ["width": W, "height": H, "lines": out], options: [])
FileHandle.standardOutput.write(data)
