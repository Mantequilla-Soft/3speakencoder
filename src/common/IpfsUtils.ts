/**
 * IPFS Utility Functions
 * Shared utilities for working with IPFS across the encoder
 */

/**
 * Convert IPFS multiaddr format to HTTP URL
 * @param multiaddr - Multiaddr string (e.g., "/ip4/127.0.0.1/tcp/5001")
 * @returns HTTP URL (e.g., "http://127.0.0.1:5001")
 * 
 * @example
 * multiaddrToUrl('/ip4/192.168.1.100/tcp/5001') 
 * // Returns: 'http://192.168.1.100:5001'
 */
export function multiaddrToUrl(multiaddr: string): string {
  // Simple conversion from multiaddr to HTTP URL
  // /ip4/127.0.0.1/tcp/5001 -> http://127.0.0.1:5001
  const parts = multiaddr.split('/');
  if (parts.length >= 5) {
    const ip = parts[2];
    const port = parts[4];
    return `http://${ip}:${port}`;
  }
  
  // Fallback to localhost if parsing fails
  return 'http://127.0.0.1:5001';
}
