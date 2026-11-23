// Commercial-rights panel. Unlike Omega's music panel, these terms have NOT been reviewed yet:
// every provider starts "unchecked". Before releasing a film commercially, read each provider's
// current terms (and the terms of the specific model used through fal), then set the light,
// the date read and the source here. The Delivery steps show this panel's state.
module.exports = {
  checked: null,
  note: 'Not yet reviewed. Read each provider\'s current terms before a commercial release and record the result here.',
  providers: [
    { id: 'anthropic', name: 'Claude (Anthropic API)', used_for: 'Writing, planning, QC, research', light: 'unchecked', terms: 'https://www.anthropic.com/legal/commercial-terms' },
    { id: 'fal', name: 'fal.ai (platform)', used_for: 'Runs the image, video and lip-sync models', light: 'unchecked', terms: 'https://fal.ai/terms', caveat: 'Each model on fal has its own license. Check the license of every model id in Settings.' },
    { id: 'elevenlabs', name: 'ElevenLabs', used_for: 'Voices, dialogue, sound effects', light: 'unchecked', terms: 'https://elevenlabs.io/terms-of-use', caveat: 'Commercial use depends on the subscription plan.' },
    { id: 'omega', name: 'Instrument Omega (your app)', used_for: 'Score and songs', light: 'see Omega', terms: 'Use Omega\'s own rights panel: only green-light music providers should be used for a release.' },
  ],
};
