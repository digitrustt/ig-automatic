# ig-automatic

Wykrywa treści, które rozpędzają się na Instagramie, robi z nich własny remiks
(hook, napis brandowy, kadr 9:16, wygenerowany caption) i publikuje na koncie
przez oficjalne Graph API.

Całość stoi na darmowych warstwach i nie wymaga niczego uruchomionego u ciebie
na komputerze.

## Jak to działa

```
źródła → ingest → snapshoty metryk → scoring → dedup → remiks → publikacja → feedback
```

Kluczowy pomysł: **viral rozpoznaje się po prędkości, nie po liczbach absolutnych.**
Post z 400 tys. wyświetleń jest nieciekawy; post, który zebrał 400 tys. w sześć
godzin — jest. System zapisuje snapshoty metryk przy każdym pollowaniu źródła i
liczy z-score przyrostu na godzinę względem baseline'u danej niszy.

Drugi pomysł: **czysty repost nie rośnie.** IG i TikTok od 2025 obcinają zasięg
kontom agregującym cudze klipy bez własnej warstwy. Każdy klip przechodzi więc
przez `remix()` — własny hook w pierwszych 2,5 s, branding konta, przekadrowanie,
świeży caption i hashtagi generowane pod voice konta.

## Stack (koszt: 0 zł)

| Warstwa | Gdzie | Limit darmowego tieru |
|---|---|---|
| Compute (ffmpeg, render, publikacja) | GitHub Actions | bez limitu minut na repo publicznym; 2000 min/mies. na prywatnym |
| Baza + storage plików | Supabase | 500 MB bazy, 1 GB storage |
| Dashboard | Vercel Hobby | wystarczająco |
| Odkrywanie treści | Instagram Graph API | 30 unikalnych hashtagów / 7 dni |
| Generowanie hooków | Groq / Cerebras / OpenRouter | tysiące zapytań dziennie — potrzebujesz ~3 |

**Runner GitHuba jest całą warstwą obliczeniową.** Ma preinstalowany ffmpeg,
4 vCPU i 16 GB RAM — czyli więcej niż twój Mac. Co 30 minut budzi się, opróżnia
kolejkę i kończy pracę. Nie ma serwera do utrzymywania.

Retencja jest wpisana w system ([lib/pipeline/cleanup.ts](lib/pipeline/cleanup.ts)),
bo bez niej 1 GB storage kończy się po trzech tygodniach: pliki wideo kasują się
3 dni po publikacji (IG ma już swoją kopię), snapshoty metryk po 21 dniach,
zakończone joby po 7. Rekordy `posts` zostają na zawsze — trzymają pHashe, dzięki
którym system nie wrzuci drugi raz tego samego klipu za miesiąc.

## Uruchomienie

### 1. Baza

Załóż darmowy projekt na [supabase.com](https://supabase.com), potem:

```bash
psql "$SUPABASE_DB_URL" -f migrations/2026-08-init.sql
```

W panelu Storage załóż bucket `renditions` (prywatny — kod sam podpisuje URL-e).

### 2. Konto na Instagramie

Musi być **Business albo Creator** i podpięte pod stronę na Facebooku. Token
potrzebuje uprawnień: `instagram_basic`, `instagram_content_publish`,
`instagram_manage_insights`, `pages_show_list`.

```sql
insert into accounts (platform, handle, platform_user_id, access_token, niche)
values ('instagram', 'twojekonto', '<ig_user_id>', '<long_lived_token>', 'fitness');
```

### 3. Źródła

```sql
insert into sources (kind, handle, niche, poll_interval_minutes) values
  ('ig_hashtag_graph', 'gymmotivation',      'fitness', 180),
  ('ig_account_graph', 'konkurencyjnekonto', 'fitness', 360);
```

Interwał pollowania jest jednocześnie oknem pomiaru prędkości — 180 minut daje
dwa punkty pomiarowe co 3 h.

### 4. Klucz do generowania hooków

Załóż darmowe konto na [console.groq.com](https://console.groq.com) i wygeneruj
klucz API. Darmowy tier to tysiące zapytań dziennie; potrzebujesz około trzech.

Alternatywy mówiące tym samym protokołem — wystarczy zmienić `LLM_BASE_URL`:
Cerebras, OpenRouter (ma modele oznaczone `:free`).

### 5. Sekrety w repo

`Settings → Secrets and variables → Actions`:

| Typ | Nazwa | Wartość |
|---|---|---|
| Secret | `NEXT_PUBLIC_SUPABASE_URL` | z panelu Supabase |
| Secret | `SUPABASE_SERVICE_ROLE_KEY` | z panelu Supabase |
| Secret | `LLM_API_KEY` | z Groq |
| Variable | `LLM_MODEL` | `llama-3.3-70b-versatile` |
| Variable | `POSTING_HOURS` | np. `11,17,20` (UTC) |

Potem `Actions → worker → Run workflow`, żeby nie czekać na pierwszy cron.

### 6. Dashboard (opcjonalnie)

Wypchnij repo na Vercela, ustaw te same zmienne Supabase. Dashboard tylko czyta
bazę — cała praca dzieje się w Actions.

## Weryfikacja renderu

```bash
npm run verify:render
```

Renderuje syntetyczny klip przez prawdziwy pipeline i sprawdza kadr, audio i
rozmiar pliku. Warto puścić po każdej zmianie w [lib/media/](lib/media/) —
`drawtext` ma własne zasady escapowania i błąd w nich widać dopiero na klatce,
nigdy w typecheckcie. Używa binarek z `ffmpeg-static`, więc nie wymaga ffmpeg
w systemie.

## Shadow mode

Domyślnie `config.shadow_mode = true` i `config.autopilot_enabled = false`.
System znajduje, ocenia, renderuje i kolejkuje — ale zamiast publikować oznacza
wpis jako `skipped_shadow`. Zobaczysz na dashboardzie dokładnie to, co by poszło
w świat, bez ryzyka.

Gdy scoring się sprawdzi na realnych danych:

```sql
update config set shadow_mode = false, autopilot_enabled = true;
```

To jest też kill-switch — jedno `update` zatrzymuje publikacje bez dotykania
workflow.

## Progi i strojenie

| Ustawienie | Domyślnie | Znaczenie |
|---|---|---|
| `config.min_score` | 2.0 | z-score prędkości wymagany do renderu |
| `config.max_posts_per_day` | 3 | twardy limit na konto |
| `config.min/max_source_age_hours` | 6 / 72 | okno wieku klipu przy ingest |
| `MIN_BASELINE_SAMPLE` | 30 | ile próbek zanim baseline zacznie ufać |
| `DUPLICATE_THRESHOLD` | 10 | dystans Hamminga pHash uznawany za duplikat |

Zanim baseline zbierze 30 próbek w niszy, `scorePost` zwraca `no_baseline_yet` i
nic nie idzie dalej. To jest zamierzone — próg bez rozkładu nic nie znaczy.
Licz na kilka dni zbierania, zanim cokolwiek się wyrenderuje.

## Warianty providera copy

`COPY_PROVIDER` przełącza generator, reszta pipeline'u się nie zmienia:

| Wartość | Co robi | Koszt |
|---|---|---|
| `cloud` (domyślne) | darmowy tier Groq / Cerebras / OpenRouter | 0 zł |
| `template` | składa hooki z szablonów, bez modelu | 0 zł |
| `ollama` | model lokalny, gdybyś kiedyś chciał u siebie | 0 zł, ale potrzebuje RAM |
| `anthropic` | Claude, wyraźnie najlepsze hooki | ~0,03 zł za post |

Jeśli wybrany provider padnie, [lib/ai/copy.ts](lib/ai/copy.ts) automatycznie
schodzi na `template` — słabszy hook i tak wychodzi, zamiast blokować całą
kolejkę renderów za sobą.

## Znane ograniczenia

- **Brak liczby wyświetleń.** Ani Hashtag Search, ani `business_discovery` nie
  zwracają odtworzeń cudzych postów — prędkość liczy się z polubień i komentarzy.
  To działa, ale jest zaszumione względem realnego zasięgu.
- **`business_discovery` widzi tylko konta Business/Creator.** Konto prywatne lub
  osobiste zwróci błąd. Źródło, które stale się wywala, to zwykle zły typ konta,
  a nie bug.
- **30 hashtagów na 7 dni.** Twardy limit Graph API na szerokość odkrywania bez
  płatnego scrapingu. Adaptery Apify zostały w kodzie jako opcja, gdybyś kiedyś
  chciał dołożyć budżet.
- **Cron GitHuba się spóźnia.** Pod obciążeniem zaplanowany przebieg potrafi
  ruszyć kilkanaście minut później, więc slot publikacji może przesunąć się o
  ~30 minut. Dla Reelsów bez znaczenia.
- **Repo prywatne = 2000 minut miesięcznie.** Przy 48 przebiegach dziennie po
  ~2 minuty to około 2880 minut — czyli za dużo. Na repo publicznym limitu nie
  ma; alternatywnie zmniejsz częstotliwość crona do `0 */2 * * *`.
- **Prawa autorskie.** Remiks nie jest licencją. Przy skalowaniu warto dołożyć
  flow zgód (DM do autora) albo trzymać się treści, na które masz pozwolenie.
- **TikTok nie jest podłączony.** Content Posting API wymaga audytu appki dla
  bezpośredniej publikacji; bez audytu można wrzucać wyłącznie do szkiców.
