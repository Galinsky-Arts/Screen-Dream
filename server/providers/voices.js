// Voice providers for dialogue, dubbing and cloning your voice. Fish Audio is the default;
// ElevenLabs is the alternative. A character's voice remembers which provider it belongs to.
const fish = require('./fish');
const eleven = require('./elevenlabs');

const PROVIDERS = {
  fish: { id: 'fish', label: 'Fish Audio', ...fish },
  elevenlabs: { id: 'elevenlabs', label: 'ElevenLabs', voices: eleven.voices, cloneVoice: eleven.cloneVoice, speak: eleven.speak, PRICE: eleven.PRICE },
};
const DEFAULT = 'fish';
const get = (id) => PROVIDERS[id] || PROVIDERS[DEFAULT];
// Speak a line in a character's voice ({ provider, voice_id }); older voices without a provider are ElevenLabs.
const speak = (voice, text) => get(voice.provider || 'elevenlabs').speak(voice.voice_id, text);

module.exports = { PROVIDERS, DEFAULT, get, speak };
