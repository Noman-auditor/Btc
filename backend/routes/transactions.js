const express = require('express');
const router = express.Router();
const btc = require('../services/bitcoin');

// ─── POST /api/tx/build ───────────────────────────────────────────────────────
// Build a transaction (preview) WITHOUT broadcasting
router.post('/build', async (req, res, next) => {
  try {
    const { wif, from_address, to_address, amount_btc, fee_rate = 'medium' } = req.body;
    if (!wif) return res.status(400).json({ error: 'WIF private key required' });
    if (!from_address) return res.status(400).json({ error: 'from_address required' });
    if (!to_address) return res.status(400).json({ error: 'to_address required' });
    if (!amount_btc || isNaN(amount_btc) || amount_btc <= 0) {
      return res.status(400).json({ error: 'Valid amount_btc required' });
    }

    const tx = await btc.buildTransaction(wif, from_address, to_address, parseFloat(amount_btc), fee_rate);

    res.json({
      success: true,
      preview: {
        from: from_address,
        to: to_address,
        amount_btc: tx.amountBTC,
        amount_sats: tx.amountSats,
        fee_btc: tx.feeBTC,
        fee_sats: tx.feeSats,
        change_btc: tx.changeBTC,
        change_sats: tx.changeSats,
        inputs_used: tx.inputCount,
        vsize_bytes: tx.vsize,
        sat_per_vbyte: tx.satPerVbyte
      },
      tx_hex: tx.txHex,
      tx_id: tx.txId
    });
  } catch (err) { next(err); }
});

// ─── POST /api/tx/send ────────────────────────────────────────────────────────
// Build AND broadcast transaction — SENDS REAL BTC
router.post('/send', async (req, res, next) => {
  try {
    const { wif, from_address, to_address, amount_btc, fee_rate = 'medium' } = req.body;

    // Validations
    if (!wif) return res.status(400).json({ error: 'WIF private key required' });
    if (!from_address) return res.status(400).json({ error: 'from_address required' });
    if (!to_address) return res.status(400).json({ error: 'to_address required' });
    if (!amount_btc || isNaN(amount_btc) || amount_btc <= 0) {
      return res.status(400).json({ error: 'Valid amount_btc required (e.g. 0.001)' });
    }
    if (from_address === to_address) {
      return res.status(400).json({ error: 'Sender and recipient cannot be the same address' });
    }

    console.log(`📤 Sending ${amount_btc} BTC → ${to_address}`);

    // Build tx
    const tx = await btc.buildTransaction(wif, from_address, to_address, parseFloat(amount_btc), fee_rate);

    // Broadcast
    const txid = await btc.broadcastTransaction(tx.txHex);

    console.log(`✅ Broadcast success: ${txid}`);

    const network = process.env.BTC_NETWORK === 'testnet' ? 'testnet' : '';
    const explorerBase = network
      ? 'https://blockstream.info/testnet/tx/'
      : 'https://blockstream.info/tx/';

    res.json({
      success: true,
      message: `✅ Transaction broadcast successfully!`,
      txid,
      explorer_url: `${explorerBase}${txid}`,
      details: {
        from: from_address,
        to: to_address,
        amount_btc: tx.amountBTC,
        fee_btc: tx.feeBTC,
        fee_sats: tx.feeSats,
        change_btc: tx.changeBTC,
        vsize_bytes: tx.vsize,
        sat_per_vbyte: tx.satPerVbyte
      }
    });
  } catch (err) { next(err); }
});

// ─── POST /api/tx/broadcast ───────────────────────────────────────────────────
// Broadcast a pre-signed raw tx hex
router.post('/broadcast', async (req, res, next) => {
  try {
    const { tx_hex } = req.body;
    if (!tx_hex) return res.status(400).json({ error: 'tx_hex required' });
    const txid = await btc.broadcastTransaction(tx_hex);
    const explorerBase = process.env.BTC_NETWORK === 'testnet'
      ? 'https://blockstream.info/testnet/tx/'
      : 'https://blockstream.info/tx/';
    res.json({ success: true, txid, explorer_url: `${explorerBase}${txid}` });
  } catch (err) { next(err); }
});

// ─── GET /api/tx/history/:address ────────────────────────────────────────────
router.get('/history/:address', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 25;
    const history = await btc.fetchTxHistory(req.params.address, limit);
    res.json({ success: true, address: req.params.address, count: history.length, transactions: history });
  } catch (err) { next(err); }
});

// ─── GET /api/tx/status/:txid ─────────────────────────────────────────────────
router.get('/status/:txid', async (req, res, next) => {
  try {
    const { data } = await require('axios').get(
      `${process.env.BTC_NETWORK === 'testnet'
        ? 'https://blockstream.info/testnet/api'
        : 'https://blockstream.info/api'}/tx/${req.params.txid}`
    );
    res.json({
      success: true,
      txid: data.txid,
      confirmed: data.status?.confirmed || false,
      block_height: data.status?.block_height || null,
      block_time: data.status?.block_time
        ? new Date(data.status.block_time * 1000).toISOString()
        : null,
      fee: data.fee,
      size: data.size,
      vsize: data.vsize
    });
  } catch (err) { next(err); }
});

module.exports = router;
