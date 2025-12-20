import QRCode from "qrcode";

/**
 * Generates a scannable QR code data URL from the given text
 * @param text - The text to encode in the QR code (e.g., wallet address)
 * @param size - The size of the QR code in pixels (default: 200)
 * @returns A data URL string that can be used as an image src
 */
export async function generateQRCode(text: string, size: number = 200): Promise<string> {
  try {
    const dataUrl = await QRCode.toDataURL(text, {
      width: size,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
    });
    return dataUrl;
  } catch (error) {
    console.error("Error generating QR code:", error);
    return "";
  }
}

