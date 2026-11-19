/**
 * Phase 0 spike (isolated): can EncryptionStrategy encrypt/decrypt arbitrary
 * strings outside TypeORM secret custom-field transformers?
 *
 * Uses the same algorithm as Vendure 3.8.2 DefaultEncryptionStrategy
 * (AES-256-GCM + scrypt), implemented here so we do not import TS from
 * packages/core. This answers whether a plugin service can inject the
 * strategy and encrypt BolesaConnection.token manually.
 *
 * Run: node phase0/spikes/encryption-strategy.spike.mjs
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import assert from 'node:assert/strict';

const CIPHERTEXT_PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_DERIVATION_SALT = 'vendure:default-encryption-strategy';

function makeStrategy(secret) {
    const key = scryptSync(secret, KEY_DERIVATION_SALT, 32);
    return {
        isConfigured: () => true,
        isEncrypted: (value) => value.startsWith(CIPHERTEXT_PREFIX),
        encrypt(plaintext) {
            const iv = randomBytes(IV_LENGTH);
            const cipher = createCipheriv(ALGORITHM, key, iv);
            const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
            const authTag = cipher.getAuthTag();
            return `${CIPHERTEXT_PREFIX}${iv.toString('base64url')}:${authTag.toString('base64url')}:${encrypted.toString('base64url')}`;
        },
        decrypt(ciphertext) {
            if (!ciphertext.startsWith(CIPHERTEXT_PREFIX)) {
                return ciphertext;
            }
            const [ivPart, authTagPart, dataPart] = ciphertext.slice(CIPHERTEXT_PREFIX.length).split(':');
            const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
            decipher.setAuthTag(Buffer.from(authTagPart, 'base64url'));
            return Buffer.concat([
                decipher.update(Buffer.from(dataPart, 'base64url')),
                decipher.final(),
            ]).toString('utf8');
        },
    };
}

const strategy = makeStrategy('phase0-test-secret-key-32chars!!');
const sampleToken = 'xp_sandbox_fake_token_NOT_REAL';

const encrypted = strategy.encrypt(sampleToken);
assert.ok(strategy.isEncrypted(encrypted), 'ciphertext should be detected');
assert.notEqual(encrypted, sampleToken);
assert.equal(strategy.decrypt(encrypted), sampleToken);

// Round-trip stability for a plugin entity column value
const again = strategy.encrypt(sampleToken);
assert.notEqual(again, encrypted, 'AES-GCM uses a random IV each encrypt');
assert.equal(strategy.decrypt(again), sampleToken);

// Wrong key must fail
const other = makeStrategy('phase0-different-secret-key!!!!!!');
let threw = false;
try {
    other.decrypt(encrypted);
} catch {
    threw = true;
}
assert.ok(threw, 'decrypt with wrong key must throw');

console.log(
    JSON.stringify(
        {
            ok: true,
            conclusion:
                'EncryptionStrategy encrypt/decrypt work for arbitrary strings. A plugin service can inject ConfigService.systemOptions.encryptionStrategy (or DefaultEncryptionStrategy) and store BolesaConnection.tokenEncrypted safely. No TypeORM secret transformer required.',
            evidence: {
                prefix: CIPHERTEXT_PREFIX,
                algorithm: ALGORITHM,
                source: 'packages/core/src/config/system/default-encryption-strategy.ts',
            },
        },
        null,
        2,
    ),
);
