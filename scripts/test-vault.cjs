// Test harness only. This file is not part of the shipped Electron bundle.
// The key exists only in this test process, and the format cannot open real vaults.
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto')
const assert = require('node:assert/strict')

function installTestVault(safeStorage) {
  const key = randomBytes(32)
  const marker = Buffer.from('CML-TEST-VAULT\0')
  let encryptions = 0, decryptions = 0
  Object.assign(safeStorage, {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => {
      encryptions++
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([marker, iv, cipher.getAuthTag(), ciphertext])
    },
    decryptString: buffer => {
      assert.ok(buffer.subarray(0, marker.length).equals(marker), 'Test codec refuses a non-test vault')
      decryptions++
      const data = buffer.subarray(marker.length)
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      cipher.setAuthTag(data.subarray(12, 28))
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8')
    }
  })
  return () => ({ encryptions, decryptions })
}

module.exports = { installTestVault }
