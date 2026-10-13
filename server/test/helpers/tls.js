/**
 * Generates a self-signed certificate for local HTTPS testing.
 * Test-only. In a real deployment TLS is terminated by the platform's proxy
 * (Fly/Render/nginx/Caddy) and the Node process speaks plain HTTP to it.
 */
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { webcrypto, X509Certificate } from "node:crypto";

const { BasicConstraintsExtension, SubjectAlternativeNameExtension, KeyUsagesExtension } = x509;

function toPem(label, binary) {
  let b64;
  if (typeof binary === "string") {
    b64 = binary;
  } else {
    // ArrayBuffer, TypedArray or Buffer -> base64
    const view = binary instanceof ArrayBuffer ? new Uint8Array(binary) : binary;
    b64 = Buffer.from(view.buffer ?? view, view.byteOffset ?? 0, view.byteLength ?? view.length).toString("base64");
  }
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * @param {string[]} hosts hostnames and/or IP addresses for the SAN
 * @returns {Promise<{cert:string,key:string,fingerprint:string,notAfter:Date}>}
 */
export async function makeTlsPems(hosts = ["localhost", "127.0.0.1"]) {
  const keys = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const notAfter = new Date(Date.now() + 24 * 3600_000);

  const san = new SubjectAlternativeNameExtension(
    hosts.map((h) =>
      // Bare IPv4/IPv6 must be tagged as IP; everything else as DNS.
      /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(":")
        ? { type: "ip", value: h }
        : { type: "dns", value: h },
    ),
  );

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=localhost",
    notBefore: new Date(Date.now() - 60_000),
    notAfter,
    signingAlgorithm: "sha256RSA",
    keys,
    extensions: [
      new BasicConstraintsExtension(true, 1, true),
      new KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.digitalSignature,
        true,
      ),
      san,
    ],
  });

  const certPem = toPem("CERTIFICATE", cert.rawData);
  const keyDer = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const keyPem = toPem("PRIVATE KEY", keyDer);

  return {
    cert: certPem,
    key: keyPem,
    fingerprint: new X509Certificate(certPem).fingerprint256,
    notAfter,
  };
}
