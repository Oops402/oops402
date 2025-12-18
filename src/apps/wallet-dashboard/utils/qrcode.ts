// Simple QR Code generator (basic implementation)
// Note: This creates a visual pattern, not a scannable QR code
// For production, consider using a library like 'qrcode' or 'qrcode.react'
export function generateQRCode(text: string, size: number = 200): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    // Simple hash-based pattern (not a real QR code, but visually similar)
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#fff";
    
    // Create a simple pattern based on text hash
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash = hash & hash;
    }
    
    const moduleSize = size / 25;
    for (let y = 0; y < 25; y++) {
      for (let x = 0; x < 25; x++) {
        const value = (Math.abs(hash) + x * 17 + y * 23) % 3;
        if (value === 0) {
          ctx.fillRect(x * moduleSize, y * moduleSize, moduleSize, moduleSize);
        }
      }
    }
    
    return canvas.toDataURL();
  } catch (error) {
    console.error("Error generating QR code:", error);
    return "";
  }
}

