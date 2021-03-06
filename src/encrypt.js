/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const crypto = require('crypto');

const ONE_BUFFER = new Buffer(1).fill(1);
const AUTH_INFO = new Buffer('Content-Encoding: auth\0', 'utf8');
const MAX_PAYLOAD_LENGTH = 4078;

/**
 * Encrypts a message such that it can be sent using the Web Push protocol.
 *
 * You can find out more about the various pieces:
 *
 * <ul>
 *  <li>{@link https://tools.ietf.org/html/draft-ietf-httpbis-encryption-encoding}</li>
 *  <li>{@link https://en.wikipedia.org/wiki/Elliptic_curve_Diffie%E2%80%93Hellman}</li>
 *  <li>{@link https://tools.ietf.org/html/draft-ietf-webpush-encryption}</li>
 * </ul>
 *
 * @memberof web-push-encryption
 * @param  {String|Buffer} message The message to be sent
 * @param  {Object} subscription  A JavaScript Object representing a
 * [PushSubscription]{@link https://developer.mozilla.org/en-US/docs/Web/API/PushSubscription}.
 * The easiest way to get this from the browser to your backend is by running
 * <code>JSON.stringify(subscription)</code> in a web pages JavaScript.
 * @param  {number} paddingLength Number of bytes of padding to use
 * @return {Object}               An Object containing the encrypted payload and
 *                                the other encryption information needed to
 *                                send the message.
 */
function encrypt(message, subscription, paddingLength) {
  paddingLength = paddingLength || 0;

  // Create Buffers for all of the inputs
  const paddingBuffer = makePadding(paddingLength);
  let messageBuffer;

  if (typeof message === 'string') {
    messageBuffer = new Buffer(message, 'utf8');
  } else if (message instanceof Buffer) {
    messageBuffer = message;
  } else {
    throw new Error('Message must be a String or a Buffer');
  }

  // The maximum size of the message + padding is 4078 bytes
  if ((messageBuffer.length + paddingLength) > MAX_PAYLOAD_LENGTH) {
    throw new Error(`Payload is too large. The max number of ` +
      `bytes is ${MAX_PAYLOAD_LENGTH}, input is ${messageBuffer.length} ` +
      `bytes plus ${paddingLength} bytes of padding.`);
  }

  const plaintext = Buffer.concat([paddingBuffer, messageBuffer]);

  if (!subscription || !subscription.keys) {
    throw new Error('Subscription has no encryption details.');
  }

  if (!subscription.keys.p256dh ||
      !subscription.keys.auth) {
    throw new Error('Subscription is missing some encryption details.');
  }

  const clientPublicKey = new Buffer(subscription.keys.p256dh, 'base64');
  const clientAuthToken = new Buffer(subscription.keys.auth, 'base64');

  if (clientAuthToken.length !== 16) {
    throw new Error('Subscription\'s Auth token is not 16 bytes.');
  }

  if (clientPublicKey.length !== 65) {
    throw new Error('Subscription\'s client key (p256dh) is invalid.');
  }

  // Create a random 16-byte salt
  const salt = crypto.randomBytes(16);

  // Use ECDH to derive a shared secret between us and the client. We generate
  // a fresh private/public key pair at random every time we encrypt.
  const serverECDH = crypto.createECDH('prime256v1');
  const serverPublicKey = serverECDH.generateKeys();
  const sharedSecret = serverECDH.computeSecret(clientPublicKey);

  // Derive a Pseudo-Random Key (prk) that can be used to further derive our
  // other encryption parameters. These derivations are described in
  // https://tools.ietf.org/html/draft-ietf-httpbis-encryption-encoding-00
  const prk = hkdf(clientAuthToken, sharedSecret, AUTH_INFO, 32);

  const context = createContext(clientPublicKey, serverPublicKey);

  // Derive the Content Encryption Key
  const contentEncryptionKeyInfo = createInfo('aesgcm', context);
  const contentEncryptionKey = hkdf(salt, prk, contentEncryptionKeyInfo, 16);

  // Derive the Nonce
  const nonceInfo = createInfo('nonce', context);
  const nonce = hkdf(salt, prk, nonceInfo, 12);

  // Do the actual encryption
  const ciphertext = encryptPayload(plaintext, contentEncryptionKey, nonce);

  // Return all of the values needed to construct a Web Push HTTP request.
  return {
    ciphertext: ciphertext,
    salt: salt,
    serverPublicKey: serverPublicKey
  };
}

/**
 * Creates a context for deriving encyption parameters.
 * See section 4.2 of
 * {@link https://tools.ietf.org/html/draft-ietf-httpbis-encryption-encoding-00}
 *
 * @private
 * @param  {Buffer} clientPublicKey The client's public key
 * @param  {Buffer} serverPublicKey Our public key
 * @return {Buffer} context
 */
function createContext(clientPublicKey, serverPublicKey) {
  // The context format is:
  // 0x00 || length(clientPublicKey) || clientPublicKey ||
  //         length(serverPublicKey) || serverPublicKey
  // The lengths are 16-bit, Big Endian, unsigned integers so take 2 bytes each.

  // The keys should always be 65 bytes each. The format of the keys is
  // described in section 4.3.6 of the (sadly not freely linkable) ANSI X9.62
  // specification.
  if (clientPublicKey.length !== 65) {
    throw new Error('Invalid client public key length');
  }

  // This one should never happen, because it's our code that generates the key
  if (serverPublicKey.length !== 65) {
    throw new Error('Invalid server public key length');
  }

  const context = new Buffer(1 + 2 + 65 + 2 + 65);
  context.write('\0', 0);
  context.writeUInt16BE(clientPublicKey.length, 1);
  clientPublicKey.copy(context, 3);
  context.writeUInt16BE(serverPublicKey.length, 68);
  serverPublicKey.copy(context, 70);
  return context;
}

/**
 * Returns an info record. See sections 3.2 and 3.3 of
 * {@link https://tools.ietf.org/html/draft-ietf-httpbis-encryption-encoding-00}
 *
 * @private
 * @param  {String} type    The type of the info record
 * @param  {Buffer} context The context for the record
 * @return {Buffer} info
 */
function createInfo(type, context) {
  if (context.length !== 135) {
    throw new Error('Context argument has invalid size');
  }

  const l = type.length;
  const info = new Buffer(18 + l + 1 + 5 + 135);

  // The start index for each element within the buffer is:
  // value               | length | start  |
  // ---------------------------------------
  // 'Content-Encoding: '|   18   | 0      |
  // type                |   l    | 18     |
  // nul byte            |   1    | 18 + l |
  // 'P-256'             |   5    | 19 + l |
  // info                |   135  | 24 + l |
  info.write('Content-Encoding: ');
  info.write(type, 18);
  info.write('\0', 18 + l);
  info.write('P-256', 19 + l);
  context.copy(info, 24 + l);

  return info;
}

/**
 * HMAC-based Extract-and-Expand Key Derivation Function (HKDF)
 *
 * This is used to derive a secure encryption key from a mostly-secure shared
 * secret.
 *
 * This is a partial implementation of HKDF tailored to our specific purposes.
 * In particular, for us the value of N will always be 1, and thus T always
 * equals HMAC-Hash(PRK, info | 0x01).
 *
 * See {@link https://www.rfc-editor.org/rfc/rfc5869.txt}
 *
 * @private
 * @param  {Buffer} salt   A non-secret random value
 * @param  {Buffer} ikm    Input keying material
 * @param  {Buffer} info   Application-specfic context
 * @param  {Number} length The length (in bytes) of the required output key
 * @return {Buffer} Key
 */
function hkdf(salt, ikm, info, length) {
  // Extract
  const prkHmac = crypto.createHmac('sha256', salt);
  prkHmac.update(ikm);
  const prk = prkHmac.digest();

  // Expand
  const infoHmac = crypto.createHmac('sha256', prk);
  infoHmac.update(info);
  infoHmac.update(ONE_BUFFER);
  return infoHmac.digest().slice(0, length);
}

/**
 * Creates a buffer of padding bytes. The first two bytes hold the length of the
 * rest of the buffer, encoded as a 16-bit integer.
 * @private
 * @param  {number} length How long the padding should be
 * @return {Buffer}        The new buffer
 */
function makePadding(length) {
  const buffer = new Buffer(2 + length);
  buffer.fill(0);
  buffer.writeUInt16BE(length, 0);
  return buffer;
}

/**
 * Encrypt the plaintext message using AES128/GCM
 * @private
 * @param  {Buffer} plaintext            The message to be encrypted, including
 *                                       padding.
 * @param  {Buffer} contentEncryptionKey The private key to use
 * @param  {Buffer} nonce                The iv
 * @return {Buffer}                      The encrypted payload
 */
function encryptPayload(plaintext, contentEncryptionKey, nonce) {
  const cipher = crypto.createCipheriv('id-aes128-GCM', contentEncryptionKey,
      nonce);
  const result = cipher.update(plaintext);
  cipher.final();

  return Buffer.concat([result, cipher.getAuthTag()]);
}

// All functions are exported here to make them testable, but only `encrypt` is
// re-exported by `index.js` as part of the public API.
module.exports = encrypt;
