#!/usr/bin/env python3
"""Limen handover briefing and demo recording script, on the product palette."""

import re
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, NextPageTemplate, Flowable,
)

OUT = "/tmp/deck/Limen_Handover_and_Demo_Script.pdf"

CANVAS = colors.HexColor("#F6F5F1")
SURFACE = colors.HexColor("#FFFFFF")
SUNK = colors.HexColor("#F1EFEA")
INK = colors.HexColor("#101418")
INK_2 = colors.HexColor("#47525C")
INK_3 = colors.HexColor("#576169")
HAIR = colors.HexColor("#E4E1D9")
HAIR_S = colors.HexColor("#D2CEC4")
PINE = colors.HexColor("#0B5F52")
PINE_DEEP = colors.HexColor("#084A40")
PINE_WASH = colors.HexColor("#E9F1EF")
PINE_LINE = colors.HexColor("#B2CCC5")
AMBER = colors.HexColor("#8A5A00")
AMBER_WASH = colors.HexColor("#FAF2E2")
AMBER_LINE = colors.HexColor("#E4CFA4")
CRIMSON = colors.HexColor("#9E1F33")
CRIM_WASH = colors.HexColor("#FBEDEF")
INVERT = colors.HexColor("#12161A")

HEAD, BODY, BOLD = "Times-Bold", "Helvetica", "Helvetica-Bold"
PAGE_W, PAGE_H = A4
M = 19 * mm
FW = PAGE_W - 2 * M

S = {
    "h1": ParagraphStyle("h1", fontName=HEAD, fontSize=17.5, leading=21, textColor=INK, spaceBefore=15, spaceAfter=7),
    "h2": ParagraphStyle("h2", fontName=BOLD, fontSize=11, leading=14.5, textColor=PINE, spaceBefore=11, spaceAfter=4),
    "body": ParagraphStyle("body", fontName=BODY, fontSize=9.5, leading=14, textColor=INK, alignment=TA_LEFT, spaceAfter=6),
    "lead": ParagraphStyle("lead", fontName=BODY, fontSize=10.5, leading=15.5, textColor=INK_2, spaceAfter=8),
    "bullet": ParagraphStyle("bullet", fontName=BODY, fontSize=9.5, leading=14, textColor=INK, leftIndent=11, bulletIndent=2, spaceAfter=3),
    "say": ParagraphStyle("say", fontName="Helvetica-Oblique", fontSize=10, leading=14.5, textColor=PINE_DEEP,
                          backColor=PINE_WASH, borderColor=PINE_LINE, borderWidth=0.6,
                          borderPadding=(8, 8, 8, 8), leftIndent=0, spaceBefore=10, spaceAfter=13),
    "do": ParagraphStyle("do", fontName=BODY, fontSize=9.5, leading=13.5, textColor=INK,
                         backColor=SUNK, borderColor=HAIR_S, borderWidth=0.6,
                         borderPadding=(8, 8, 8, 8), spaceBefore=10, spaceAfter=13),
    "warn": ParagraphStyle("warn", fontName=BODY, fontSize=9.5, leading=13.5, textColor=INK,
                           backColor=AMBER_WASH, borderColor=AMBER_LINE, borderWidth=0.7,
                           borderPadding=(8, 8, 8, 8), spaceBefore=10, spaceAfter=13),
    "code": ParagraphStyle("code", fontName="Courier", fontSize=8.6, leading=12.4, textColor=PINE_DEEP,
                           backColor=INVERT, borderPadding=(8, 8, 8, 8), spaceBefore=10, spaceAfter=13),
    "cap": ParagraphStyle("cap", fontName="Helvetica-Oblique", fontSize=8.2, leading=11.4, textColor=INK_3, spaceAfter=9),
    "cell": ParagraphStyle("cell", fontName=BODY, fontSize=8.4, leading=11.4, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName=BOLD, fontSize=8.4, leading=11.4, textColor=INK),
    "cellm": ParagraphStyle("cellm", fontName="Courier", fontSize=7.9, leading=11.4, textColor=PINE_DEEP),
    "time": ParagraphStyle("time", fontName=BOLD, fontSize=12.5, leading=16, textColor=PINE, spaceBefore=20, spaceAfter=4),
}

story = []
def h1(t): story.append(Paragraph(t, S["h1"]))
def h2(t): story.append(Paragraph(t, S["h2"]))
def p(t): story.append(Paragraph(t, S["body"]))
def lead(t): story.append(Paragraph(t, S["lead"]))
def cap(t): story.append(Paragraph(t, S["cap"]))
def say(t): story.append(Paragraph('&#8220;' + t + '&#8221;', S["say"]))
def do(t): story.append(Paragraph('<b>On screen:</b> ' + t, S["do"]))
def warn(t): story.append(Paragraph(t, S["warn"]))
def timecode(t): story.append(Paragraph(t, S["time"]))


def bullets(items):
    for i in items:
        story.append(Paragraph(i, S["bullet"], bulletText="\u2022"))
    story.append(Spacer(1, 5))


def code(t):
    story.append(Paragraph(t.replace("\n", "<br/>").replace(" ", "&nbsp;"),
                           ParagraphStyle("c", parent=S["code"], textColor=colors.HexColor("#7FE3CC"))))


def table(rows, widths, head=True):
    data = []
    for i, r in enumerate(rows):
        row = []
        for c in r:
            c = str(c)
            if c.startswith("`") and c.endswith("`") and c.count("`") == 2:
                row.append(Paragraph(c[1:-1], S["cellm"]))
            else:
                c = re.sub(r"`([^`]+)`", r'<font face="Courier" size="7.9" color="#084A40">\1</font>', c)
                row.append(Paragraph(c, S["cellb"] if (head and i == 0) else S["cell"]))
        data.append(row)
    t = Table(data, colWidths=widths, repeatRows=1 if head else 0)
    st = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 5),
          ("BOTTOMPADDING", (0, 0), (-1, -1), 5), ("LEFTPADDING", (0, 0), (-1, -1), 7),
          ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("BACKGROUND", (0, 1), (-1, -1), SURFACE),
          ("LINEBELOW", (0, 0), (-1, -2), 0.4, HAIR), ("BOX", (0, 0), (-1, -1), 0.6, HAIR_S)]
    if head:
        st += [("BACKGROUND", (0, 0), (-1, 0), PINE_WASH), ("LINEBELOW", (0, 0), (-1, 0), 0.9, PINE)]
    t.setStyle(TableStyle(st))
    story.append(t); story.append(Spacer(1, 10))


def cover(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(CANVAS); canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    canvas.setFillColor(PINE_WASH); canvas.circle(PAGE_W + 30, PAGE_H - 20, 165, stroke=0, fill=1)
    canvas.setFillColor(INVERT); canvas.roundRect(M, PAGE_H - M - 34, 34, 34, 7, stroke=0, fill=1)
    canvas.setFillColor(colors.white); canvas.setFont(HEAD, 19)
    canvas.drawCentredString(M + 17, PAGE_H - M - 25, "L")
    canvas.setFillColor(INK); canvas.setFont(BOLD, 9.5)
    canvas.drawString(M + 44, PAGE_H - M - 22, "L I M E N")

    canvas.setFont(HEAD, 31); canvas.setFillColor(INK)
    canvas.drawString(M, PAGE_H - 172, "Handover and")
    canvas.drawString(M, PAGE_H - 208, "Demo Recording Script")
    canvas.setStrokeColor(PINE); canvas.setLineWidth(2.2)
    canvas.line(M, PAGE_H - 229, M + 64, PAGE_H - 229)
    canvas.setFillColor(INK_2); canvas.setFont(BODY, 11.5)
    canvas.drawString(M, PAGE_H - 257, "Everything you need to understand the project and record")
    canvas.drawString(M, PAGE_H - 274, "the demo video without me.")

    bx, by, bw, bh = M, 400, FW * 0.66, 128
    canvas.setFillColor(SURFACE); canvas.setStrokeColor(HAIR_S); canvas.setLineWidth(0.8)
    canvas.roundRect(bx, by, bw, bh, 7, stroke=1, fill=1)
    canvas.setFillColor(INK_3); canvas.setFont(BOLD, 7.4)
    canvas.drawString(bx + 16, by + bh - 22, "T H E   O N E   L I N E")
    canvas.setFillColor(INK); canvas.setFont(HEAD, 17)
    canvas.drawString(bx + 16, by + bh - 52, "The agent can negotiate the deal.")
    canvas.drawString(bx + 16, by + bh - 76, "It cannot change what it may spend.")
    canvas.setFillColor(INK_2); canvas.setFont(BODY, 9.5)
    canvas.drawString(bx + 16, by + 22, "If the video lands only this, the video worked.")

    canvas.setStrokeColor(HAIR_S); canvas.setLineWidth(0.7)
    canvas.line(M, 150, PAGE_W - M, 150)
    canvas.setFillColor(INK); canvas.setFont(BOLD, 9)
    canvas.drawString(M, 130, "Team Nexara9")
    canvas.setFillColor(INK_2); canvas.setFont(BODY, 9)
    canvas.drawString(M, 114, "M. Navya, 124CS0001   \u00b7   Sujal Negi, 123ME0023   \u00b7   IIITDM Kurnool")
    canvas.drawString(M, 99, "RizeOS Hackathon, AI Track")
    canvas.setFillColor(INK_3); canvas.setFont(BODY, 8.2)
    canvas.drawString(M, 74, "github.com/sujal128005/limen   \u00b7   covenant-j1op.onrender.com")
    canvas.restoreState()


def body_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(CANVAS); canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    canvas.setFillColor(INK_3); canvas.setFont(BODY, 7.4)
    canvas.drawString(M, 12 * mm, "Limen  \u00b7  Handover and Demo Recording Script")
    canvas.drawRightString(PAGE_W - M, 12 * mm, str(canvas.getPageNumber() - 1))
    canvas.setStrokeColor(HAIR); canvas.setLineWidth(0.5)
    canvas.line(M, 15 * mm, PAGE_W - M, 15 * mm)
    canvas.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=M, rightMargin=M, topMargin=M,
                      bottomMargin=21 * mm, title="Limen Handover and Demo Recording Script",
                      author="Nexara9")
doc.addPageTemplates([
    PageTemplate(id="cover", frames=[Frame(M, M, FW, PAGE_H - 2 * M, id="c")], onPage=cover),
    PageTemplate(id="body", frames=[Frame(M, 21 * mm, FW, PAGE_H - M - 21 * mm, id="b")], onPage=body_page),
])
story.append(NextPageTemplate("body")); story.append(PageBreak())

# ============================================================== PART 1
h1("Part 1. What the project is")
lead("Limen is a procurement agent that takes a plain-language sourcing request, screens a "
     "supplier catalogue, negotiates in parallel with the suppliers that qualify, recommends one "
     "deal and settles payment through an escrow contract. It does all of that on its own.")
p("The one thing it cannot do is decide how much it is allowed to spend. The buyer writes a "
  "per-deal ceiling into the escrow contract, and the contract checks it on every purchase. The "
  "agent can be wrong, confused or actively manipulated, and the ceiling still holds.")

h2("Why that is the interesting part")
p("The usual way to stop an agent overspending is an instruction: <i>you must never spend more "
  "than $1,200</i>. That instruction arrives through the same channel as any attack, is read by the "
  "same model the attack is targeting, and gives no signal when it fails. It is a request, not a "
  "control.")
p("Limen moves the limit into contract storage the agent has no route to modify. The policy "
  "record is keyed on the caller, so the only policy the agent can write is its own. Escalation is "
  "not blocked by a check that might have a bug. It cannot be expressed.")

h2("The two facts to memorise")
table([
    ["What happens", "Why it matters"],
    ["The agent raises its own cap to $1,000,000 and it works.",
     "Its own policy genuinely changes. This is not faked."],
    ["The next spend is still rejected at $1,200.",
     "Because the contract reads the <b>buyer's</b> record, not the agent's."],
], [FW * 0.46, FW * 0.54])

h2("The worked run, in numbers")
table([
    ["Figure", "Value", "Where it comes from"],
    ["Budget stated by the buyer", "$1,200", "Typed in the request box"],
    ["Listings screened", "7", "Of 39 in the catalogue, matching PET resin"],
    ["Shortlisted for negotiation", "3", "The rest failed a hard constraint"],
    ["Rounds to agreement", "3", "Bounded alternating offers"],
    ["Settled at", "$1,175", "$2.35/kg for 500 kg"],
    ["Saved against list", "$75", "List was $1,250"],
    ["Suppliers that walked away", "2", "The agent refused to exceed the ceiling"],
], [50 * mm, 22 * mm, FW - 72 * mm])
cap("Every one of these is computed by the engine and checked by the contract. None is illustrative.")

# ============================================================== PART 2
h1("Part 2. Before you record")

h2("Start it up")
p("Two terminals are not needed. One is enough.")
code("cd C:\\Users\\connt\\Documents\\druggen\\agentsource\n"
     "npm start\n\n"
     "# wait for:  Limen running -> http://localhost:4000\n"
     "# first boot compiles Solidity, so give it 15 to 30 seconds")
p("Then open <font face='Courier' size='8.6'>http://localhost:4000</font> and hard refresh with "
  "<b>Ctrl+Shift+R</b>. If the page looks like an older version, that refresh is why.")

h2("Set the window up")
bullets([
    "Browser at <b>1512 x 900 or wider</b>. Zoom at 100 percent, not 110.",
    "Hide the bookmarks bar with <b>Ctrl+Shift+B</b>. Close other tabs.",
    "Use <b>Light</b> theme for the recording. It is the product's identity and matches the deck and the document.",
    "Record at 1080p, 30fps. OBS or Windows Game Bar (<b>Win+G</b>) both work.",
])

h2("Do one silent practice run first")
p("This matters more than anything else on this page. The first run of the day is slower because "
  "the chain is cold. Run the whole thing once without recording, then press <b>Reset run</b>, and "
  "record the second one. The click positions will also be in your hands by then.")

warn("<b>Important:</b> after any full run that reaches settlement, press <b>Reset run</b> before "
     "the real take. Otherwise the run starts with a spending policy already published and the "
     "attack buttons will not tell the story in the right order.")

h2("Target length")
p("<b>Three minutes thirty.</b> Four minutes is the hard ceiling. Speak slightly slower than feels "
  "natural. The figures are the content, so give each one a beat before moving the mouse.")

story.append(PageBreak())

# ============================================================== PART 3
h1("Part 3. The recording script")
p("Timings are a guide, not a stopwatch. If a section runs long, cut from the interface tour at "
  "2:35, never from the two attacks.")

timecode("0:00 to 0:22   |   The problem")
do("The homepage, untouched. Do not move the mouse for the first ten seconds. Let the headline and "
   "the mandate card sit.")
say("Procurement teams will not let software spend their money. Not because it cannot find "
    "suppliers, and not because it cannot negotiate. It is that nobody wants to give a program a "
    "company card and hope it behaves. The usual fix is to write a spending limit into the agent's "
    "instructions. That is a limit the agent enforces on itself. This is Limen. We moved the "
    "limit somewhere the agent cannot reach.")
do("At about 0:16, move the cursor slowly over the mandate card on the right. Rest on the $1,200 "
   "ceiling, then on the two <i>reverted</i> rows. Two seconds each.")

timecode("0:22 to 0:40   |   The claim, and into the product")
say("The buyer sets a ceiling. It is written into a smart contract. The agent works underneath it "
    "and never holds the pen. Watch what that means in practice.")
do("Scroll once to the authority section, pause two seconds on the two columns, then scroll back "
   "up and click <b>Try the demo workspace</b>.")

timecode("0:40 to 1:20   |   The run")
do("The sourcing desk. The request is already filled in. Read it out, then click <b>Run sourcing</b>.")
say("Five hundred kilos of bottle-grade PET resin. Twelve hundred dollars. Fourteen days. It has to "
    "be food-contact certified.")
do("The capsule at the top of the screen fires immediately. Let it run. It counts the phase, one of "
   "five through to five of five, with a clock and a progress bar.")
say("It reads the request, screens the catalogue, then negotiates with three suppliers in parallel. "
    "Each supplier holds a floor price the agent cannot see. It opens low, concedes on a schedule, "
    "and walks away rather than cross the ceiling. Two of the three end without a deal.")
do("Let the negotiation transcripts reveal. Do not scroll during this, the page follows the agent "
   "on its own. Around 1:10 the capsule turns amber and says <b>Your decision</b>.")

timecode("1:20 to 1:45   |   The stop")
do("The page has dimmed everything above the approval card and will not scroll past it. Point this "
   "out. Try scrolling down once to show that it holds.")
say("This is the part I want you to notice. The agent is autonomous right up to the moment money "
    "would move, and then it stops. Everything above dims. The page will not carry you past the "
    "decision. It found the deal, but it does not get to make it.")
do("Show the brief: what happened, what changes, what deserves attention, whether it can be undone.")
say("Eleven seventy-five, three rounds, seventy-five dollars under list. It also tells me a cheaper "
    "listing existed and was excluded on a certification I asked for. Price is negotiable. A "
    "certificate is not.")

timecode("1:45 to 2:05   |   Approve and publish")
do("Tick the acknowledgement, type a name, click to sign. Then click <b>Publish spending policy "
   "on-chain</b>.")
say("I approve it, and I publish the ceiling to the contract. From here the agent can commit up to "
    "twelve hundred dollars and no further, and it cannot raise that itself.")

timecode("2:05 to 2:45   |   The two attacks. Do not cut this.")
do("Click <b>Force the agent to spend $1,250</b>. Wait for the revert. Zoom is not needed, the "
   "error is large.")
say("First, I tell the agent to spend twelve fifty against a twelve hundred limit. That is a real "
    "transaction. It is mined, and it fails. ExceedsPerDealCap. No partial spend, no override.")
do("Click <b>Now let the agent raise its own limit</b>. Let both results land.")
say("Now the interesting one. I let the agent rewrite its own policy, and set its own cap to a "
    "million dollars. That succeeds. Its own policy genuinely changes. And the spend is still "
    "rejected, because the contract reads the buyer's record, not the agent's. The agent is allowed "
    "to try. The contract is what stops it.")

timecode("2:45 to 3:10   |   Settlement and the document")
do("Approve and fund escrow, confirm delivery, release payment. Then open the agreement PDF.")
say("The valid deal goes through. Funds sit in escrow until I confirm delivery, then they release "
    "to the supplier and the reputation is written on-chain. The agreement is generated server-side, "
    "with the suppliers that lost and the reason each one lost.")

timecode("3:10 to 3:30   |   Close")
do("Open Rationale with the floating control, ask one question, let the answer land. Then stop.")
say("It explains itself from the run rather than from a model's memory, and it cannot sign, approve "
    "or move funds. That is enforced in code, not asked for in a prompt. The limit is contract "
    "state. The agent cannot raise it.")

story.append(PageBreak())

# ============================================================== PART 4
h1("Part 4. Things to be careful about")
p("The strongest thing about this project is that the claims are true. Please do not overstate them "
  "on camera, because a judge who catches one exaggeration will discount everything else.")

table([
    ["Do not say", "Say instead"],
    ["\"It is deployed on Ethereum.\"", "\"It runs an EVM chain in the process. RPC_URL points it at a public network.\""],
    ["\"These are real suppliers.\"", "\"The catalogue is seeded demo data, fifteen suppliers across thirteen countries.\""],
    ["\"The delivery is verified.\"", "\"Delivery is confirmed by the buyer. There is no oracle yet, and the brief says so.\""],
    ["\"It is a legally binding signature.\"", "\"It records a name, a timestamp and a document hash.\""],
    ["\"The AI negotiates.\"", "\"The negotiation is deterministic code. The model only rewords explanations.\""],
], [FW * 0.42, FW * 0.58])

p("Naming what is simulated is what makes the enforced part credible. If a judge asks what is real, "
  "the honest answer is a strong one: the contract enforcement, the transactions and reverts, the "
  "escrow custody and release, the on-chain reputation, and the document hashing.")

h1("Part 5. If something goes wrong")
table([
    ["Symptom", "Fix"],
    ["Page looks like an older version", "Hard refresh with Ctrl+Shift+R. The browser cached the old bundle."],
    ["Button says \"Starting the chain\"", "The chain is still booting. Wait, it takes 15 to 30 seconds on first start."],
    ["Attack buttons behave oddly", "A policy is already published from a previous run. Press <b>Reset run</b> and start again."],
    ["The run seems frozen mid-negotiation", "Keep the browser tab in the foreground. Background tabs throttle timers."],
    ["\"No wallet detected\" on the sign-in screen", "Expected without a wallet extension. Use <b>Use the demo workspace</b>, or install MetaMask if you want to show that path."],
    ["Server will not start", "Something is already on port 4000. Close the old terminal, or set PORT=4001."],
], [FW * 0.36, FW * 0.64])

h2("Useful things you may want on camera")
bullets([
    "<b>Ctrl+K</b> or <b>/</b> opens the command palette. Good for a two second shot if you have room.",
    "<b>17 built-in scenarios</b> in the request box, across packaging, metals, mechanical, electrical, electronics, medical and aerospace. <i>Budget too low</i> is a good one if you want to show the agent refusing to find a deal at all.",
    "The <b>Limen</b> mark at the top left goes back to the homepage without discarding the run.",
    "<b>Light, Dark and System</b> themes in the sidebar. Dark looks good but record in Light for consistency with the deck.",
])

h1("Part 6. Where everything lives")
table([
    ["File", "What it is"],
    ["`docs/Limen_Technical_Documentation.pdf`", "Nine page technical document. Architecture, security model, testing."],
    ["`docs/Limen_Pitch_Deck.pptx`", "Sixteen slide deck, same visual identity."],
    ["`README.md`", "Setup, architecture, test counts, honest limitations."],
    ["`npm test`", "106 unit and contract tests."],
    ["`npm run sweep`", "101 checks against a running server. Needs `npm start` in another terminal."],
], [66 * mm, FW - 66 * mm])

p("The repository is current and the CI check is green. Nothing needs to be committed before you "
  "record, and nothing about the recording changes the code.")

story.append(Spacer(1, 8))
story.append(Paragraph("Good luck. If only one idea survives the three minutes, make it this one: "
                       "the agent is allowed to try, and the contract is what stops it.", S["lead"]))

doc.build(story)
print("written", OUT)
