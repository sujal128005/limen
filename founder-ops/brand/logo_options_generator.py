OPTS = [
  ("A", "Midnight navy", ("#3A5A8C", "#1E3358"), "Navy and gold: classic, trustworthy, close to today's Limen navy."),
  ("B", "Deep emerald", ("#2F7A68", "#174A40"), "Green and gold: money, growth, and very Indian-premium."),
  ("C", "Graphite", ("#6B7480", "#363C45"), "Steel grey and gold: industrial and quiet, lets the gold lead."),
  ("D", "Royal maroon", ("#8C3A4A", "#56202C"), "Maroon and gold: bold and warm, stands apart from other B2B tools."),
]
GOLD = ("#F6D98A", "#E2B862", "#B8873A")

def mark(i, arch, size=220):
    a1, a2 = arch
    return f'''<svg width="{size}" height="{size*0.72:.0f}" viewBox="0 0 240 172" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="ar{i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{a1}"/><stop offset="1" stop-color="{a2}"/></linearGradient>
    <linearGradient id="gd{i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{GOLD[0]}"/><stop offset=".5" stop-color="{GOLD[1]}"/><stop offset="1" stop-color="{GOLD[2]}"/></linearGradient>
  </defs>
  <path d="M34 118 V74 Q34 30 78 30 H162 Q206 30 206 74 V96" fill="none" stroke="url(#ar{i})" stroke-width="26" stroke-linecap="butt" stroke-linejoin="round"/>
  <path d="M21 134 H118 L106 160 H21 Z" fill="url(#gd{i})"/>
</svg>'''

cards = ""
for i, (k, name, arch, note) in enumerate(OPTS):
    cards += f'''
<section class="opt">
  <h2>Option {k} <span>{name}</span></h2>
  <div class="pair">
    <div class="tile dark">{mark(f"d{i}", arch)}<div class="word"><b>Limen</b><small>by Nexara9</small></div></div>
    <div class="tile light">{mark(f"l{i}", arch)}<div class="word ink"><b>Limen</b><small>by Nexara9</small></div></div>
  </div>
  <div class="small">
    <div class="ic dark">{mark(f"s{i}", arch, 60)}</div>
    <div class="ic light">{mark(f"t{i}", arch, 60)}</div>
    <div class="sw"><i style="background:{arch[1]}"></i><span>Primary (buttons, links)<br><code>{arch[1]}</code></span></div>
    <div class="sw"><i style="background:{GOLD[1]}"></i><span>Accent (highlights)<br><code>{GOLD[1]}</code></span></div>
  </div>
  <p>{note}</p>
</section>'''

html = f'''<!doctype html><html><head><meta charset="utf-8"><style>
body{{margin:0;background:#F4F1EA;font-family:Inter,system-ui,sans-serif;color:#1F1A12;padding:32px}}
h1{{font-size:26px;margin:0 0 4px}} .lead{{color:#6B6253;margin:0 0 24px}}
.grid{{display:grid;grid-template-columns:repeat(2,1fr);gap:22px}}
.opt{{background:#fff;border-radius:16px;padding:20px;box-shadow:0 10px 30px -18px rgba(0,0,0,.35)}}
h2{{font-size:18px;margin:0 0 14px}} h2 span{{font-weight:500;color:#8A7F6C}}
.pair{{display:flex;flex-direction:column;gap:12px}}
.tile{{border-radius:14px;padding:26px;display:flex;align-items:center;gap:18px;justify-content:center}}
.dark{{background:radial-gradient(circle at 30% 20%,#3A3226,#1E1A14)}} .light{{background:#FAF8F3;border:1px solid #E8E1D3}}
.word b{{display:block;font-size:40px;letter-spacing:-.03em;background:linear-gradient(135deg,#F6D98A,#C9973F);-webkit-background-clip:text;color:transparent}}
.word.ink b{{background:none;color:#2B2318}} .word small{{color:#A8987A;font-size:13px;letter-spacing:.12em;text-transform:uppercase}}
.small{{display:flex;align-items:center;gap:10px;margin-top:14px}}
.ic{{width:64px;height:64px;border-radius:14px;display:grid;place-items:center}}
.sw{{display:flex;gap:8px;align-items:center;font-size:12px;color:#5C5444}} .sw i{{width:26px;height:26px;border-radius:7px;flex:none}}
code{{font-size:11px}} p{{font-size:13.5px;color:#6B6253;margin:12px 0 0}}
</style></head><body>
<h1>Limen logo: arch colour options (round 2)</h1>
<p class="lead">Right leg now stops at about 75% of the left leg's height. The bar stays Nexara9 gold; the arch moves off gold to a darker partner colour.</p>
<div class="grid">{cards}</div></body></html>'''
open("options.html", "w").write(html)
