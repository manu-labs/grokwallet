import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";

function suite() {
  return new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
}

/**
 * HPKE recipient matching Privy's Node SDK (DHKEM P-256, HKDF-SHA256, ChaCha20-Poly1305, mode BASE).
 * The public key is base64 SPKI, which is what POST /wallets/authenticate expects.
 */
export async function createHpkeRecipient() {
  const hpke = suite();
  const keypair = await hpke.kem.generateKeyPair();
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keypair.publicKey));
  const rawPublicKey = new Uint8Array(await hpke.kem.serializePublicKey(keypair.publicKey));
  return {
    publicKeyBase64: Buffer.from(spki).toString("base64"),
    rawPublicKey,
    async decrypt(encapsulatedKeyBase64, ciphertextBase64) {
      const recipient = await hpke.createRecipientContext({
        recipientKey: keypair.privateKey,
        enc: Buffer.from(encapsulatedKeyBase64, "base64"),
      });
      const opened = await recipient.open(Buffer.from(ciphertextBase64, "base64"));
      return new TextDecoder().decode(opened);
    },
  };
}

export async function sealForRecipient(rawPublicKey, plaintext) {
  const hpke = suite();
  const recipientPublicKey = await hpke.kem.deserializePublicKey(rawPublicKey);
  const sender = await hpke.createSenderContext({ recipientPublicKey });
  const ciphertext = new Uint8Array(await sender.seal(plaintext));
  return {
    encapsulatedKey: Buffer.from(sender.enc).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  };
}
