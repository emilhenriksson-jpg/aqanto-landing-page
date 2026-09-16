/**
 * The page for someone who typed the address.
 *
 * `photographic.space` without the `mcp.` prefix serves nothing today, and that is what a
 * person types. This is what it should serve: what the product is, in plain Swedish, and a
 * way in for someone who already has an account.
 *
 * Two rules held it in shape. It says nothing that is not built — no voice, no
 * summaries, no knowledge graph, and no promise that anyone can sign up today, because SMS
 * delivery is not paid for and a signup form here would be a dead end for a stranger. And
 * it leads with what the product is *for* rather than with its architecture: the reason to
 * care is that a memory you gave one model is not a memory you can take to the next one.
 *
 * It lives in the auth app because every way in already does, and because it must render
 * for someone with no session at all.
 */
export function Landing({
  onLogin,
  notice,
}: {
  onLogin: () => void;
  /** A sign-out or expired session deserves a human answer before the phone prompt. */
  notice?: string;
}) {
  return (
    <div className="landing">
      <section className="landing__hero">
        <h1 className="landing__title">Ditt minne, inte modellens.</h1>
        <p className="landing__lede">
          Photographic är minnet under AI-modellerna. Du berättar något en gång — vem du är,
          hur du vill bli bemött, vad ni bestämde — och den modell du väljer att prata med får
          läsa det, med ditt tillstånd. Byter du modell börjar du inte om.
        </p>
        {notice ? <p className="landing__notice" role="status">{notice}</p> : null}
        <div className="landing__actions">
          <button type="button" className="btn btn--primary" onClick={onLogin}>
            Logga in
          </button>
          <p className="meta landing__actions-note">
            Har du fått en inbjudan? Öppna länken du fick — den tar dig hela vägen in.
          </p>
        </div>
      </section>

      <section className="landing__points" aria-label="Vad Photographic gör">
        <article className="landing__point">
          <h2>Minnet ligger under modellerna</h2>
          <p>
            Claude, ChatGPT och det som kommer efter dem är gränssnitt. Photographic är
            lagret under, och det ansluts som en vanlig MCP-server. Inget av det du sparat
            försvinner med ett konto hos någon annan.
          </p>
        </article>

        <article className="landing__point">
          <h2>Du ser varför något står där</h2>
          <p>
            Varje minne bär med sig när det lärdes, varifrån det kom och vilken modell som
            skrev det. Ingenting hamnar i ett delat rum utan att du godkänner det, och det
            som sparas åt dig får en läsbar motivering.
          </p>
        </article>

        <article className="landing__point">
          <h2>Privat minne, och rum du väljer att dela</h2>
          <p>
            Ditt privata minne exponeras aldrig genom ett delat rum. Rummen är för det som
            faktiskt är gemensamt — ett projekt, en ledningsgrupp, ett hem.
          </p>
        </article>

        <article className="landing__point">
          <h2>Du kan ta det med dig, och du kan lämna</h2>
          <p>
            Exporten är hela loggen plus dina filer, i ett arkiv som går att läsa utan oss.
            Borttaget ligger 30 dagar i papperskorgen, och en kontoradering är på riktigt —
            direkt, eller med 30 dagars ångerfrist om du vill hinna ändra dig.
          </p>
        </article>
      </section>

      <p className="meta landing__honesty">
        Photographic är i tidig drift. Nya konton öppnas inte för alla ännu, svenska
        mobilnummer är enda vägen in, och det som inte är byggt står inte här.
      </p>
    </div>
  );
}
