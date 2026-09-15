import './styles/app.css';

/**
 * Placeholder surface until the realtime voice client ships. Brand first, one calm
 * Swedish sentence, one violet control — nothing else in the first viewport.
 */
const root = document.querySelector('#app');
if (!root) throw new Error('missing #app');

root.innerHTML = `
  <section class="landing" aria-labelledby="voice-brand">
    <div class="wordmark wordmark--large" id="voice-brand">
      <span class="wordmark__dot" aria-hidden="true"></span>
      <span class="wordmark__name">Photographic</span>
    </div>
    <p class="landing__lede">Prata in minnen. De landar i rätt rum.</p>
    <button type="button" class="btn btn--primary" disabled>Kommer snart</button>
  </section>
`;
