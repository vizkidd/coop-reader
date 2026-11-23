// Deployment settings. Leave empty to use the public defaults (PeerJS cloud, the project's relay, public STUN).
// Self-hosting? Edit this one file; see docs/SELFHOST.md. Every value can still be overridden per browser in the app's Network settings.
window.COOP_CONFIG = {
  // peer:  { host: 'peers.example.org', port: 443, path: '/coop', key: 'peerjs', secure: true },   // your PeerJS signalling server
  // relay: 'wss://relay.example.org',                                                             // your relay worker
  // ice:   [{ urls: 'stun:stun.example.org:3478' }, { urls: 'turn:turn.example.org:3478', username: 'u', credential: 'p' }],   // replaces the built-in STUN/TURN list
  // noWidget: true,                                                                               // never load the donation widget
};
