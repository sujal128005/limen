#!/usr/bin/env python3
"""Covenant technical documentation, on the product's light palette."""

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

OUT = "/tmp/deck/Covenant_Technical_Documentation.pdf"

# Straight from web/src/styles.css, [data-theme="light"].
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
CRIMSON = colors.HexColor("#9E1F33")
INVERT = colors.HexColor("#12161A")
MINT = colors.HexColor("#3FBFA3")

HEAD = "Times-Bold"
BODY = "Helvetica"
BOLD = "Helvetica-Bold"

PAGE_W, PAGE_H = A4
M = 19 * mm
FW = PAGE_W - 2 * M

S = {
    "h1": ParagraphStyle("h1", fontName=HEAD, fontSize=17.5, leading=21, textColor=INK,
                         spaceBefore=15, spaceAfter=7),
    "h2": ParagraphStyle("h2", fontName=BOLD, fontSize=11, leading=14.5, textColor=PINE,
                         spaceBefore=11, spaceAfter=4),
    "body": ParagraphStyle("body", fontName=BODY, fontSize=9.5, leading=14, textColor=INK,
                           alignment=TA_LEFT, spaceAfter=6),
    "lead": ParagraphStyle("lead", fontName=BODY, fontSize=10.5, leading=15.5, textColor=INK_2,
                           spaceAfter=8),
    "bullet": ParagraphStyle("bullet", fontName=BODY, fontSize=9.5, leading=14, textColor=INK,
                             leftIndent=11, bulletIndent=2, spaceAfter=3),
    "code": ParagraphStyle("code", fontName="Courier", fontSize=8.2, leading=11.6,
                           textColor=PINE_DEEP, backColor=SUNK, borderColor=HAIR, borderWidth=0.6,
                           borderPadding=(7, 7, 7, 7), spaceBefore=4, spaceAfter=9),
    "cap": ParagraphStyle("cap", fontName="Helvetica-Oblique", fontSize=8.2, leading=11.4,
                          textColor=INK_3, spaceAfter=9),
    "cell": ParagraphStyle("cell", fontName=BODY, fontSize=8.4, leading=11.4, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName=BOLD, fontSize=8.4, leading=11.4, textColor=INK),
    "cellm": ParagraphStyle("cellm", fontName="Courier", fontSize=7.9, leading=11.4, textColor=PINE_DEEP),
    "pull": ParagraphStyle("pull", fontName=HEAD, fontSize=13, leading=18, textColor=PINE,
                           leftIndent=12, spaceBefore=4, spaceAfter=10),
}

story = []


def h1(t): story.append(Paragraph(t, S["h1"]))
def h2(t): story.append(Paragraph(t, S["h2"]))
def p(t): story.append(Paragraph(t, S["body"]))
def lead(t): story.append(Paragraph(t, S["lead"]))
def cap(t): story.append(Paragraph(t, S["cap"]))


def bullets(items):
    for i in items:
        story.append(Paragraph(i, S["bullet"], bulletText="•"))
    story.append(Spacer(1, 5))


def code(t, keep_with=None):
    para = Paragraph(t.replace("\n", "<br/>").replace(" ", "&nbsp;"), S["code"])
    if keep_with:
        story.append(KeepTogether(keep_with + [para]))
    else:
        story.append(para)


def pull(t):
    story.append(Paragraph(t, S["pull"]))


def table(rows, widths, head=True):
    data = []
    for i, r in enumerate(rows):
        row = []
        for c in r:
            c = str(c)
            if c.startswith("`") and c.endswith("`") and c.count("`") == 2:
                row.append(Paragraph(c[1:-1], S["cellm"]))
            else:
                # Inline code spans inside ordinary cell text. Handling only the
                # whole-cell case left visible backticks in three cells.
                c = re.sub(r"`([^`]+)`",
                           r'<font face="Courier" size="7.9" color="#084A40">\1</font>', c)
                row.append(Paragraph(c, S["cellb"] if (head and i == 0) else S["cell"]))
        data.append(row)
    t = Table(data, colWidths=widths, repeatRows=1 if head else 0)
    st = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("BACKGROUND", (0, 1), (-1, -1), SURFACE),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, HAIR),
        ("BOX", (0, 0), (-1, -1), 0.6, HAIR_S),
    ]
    if head:
        st += [("BACKGROUND", (0, 0), (-1, 0), PINE_WASH),
               ("LINEBELOW", (0, 0), (-1, 0), 0.9, PINE)]
    t.setStyle(TableStyle(st))
    story.append(t)
    story.append(Spacer(1, 10))


class Rule(Flowable):
    """A hairline the width of the frame, used between major sections."""
    def __init__(self, w): self.w = w; self.height = 1
    def wrap(self, *a): return (self.w, 9)
    def draw(self):
        self.canv.setStrokeColor(HAIR_S)
        self.canv.setLineWidth(0.7)
        self.canv.line(0, 4, self.w, 4)


class Flow(Flowable):
    """The run as a horizontal chain of stages, coloured by who is accountable."""
    def __init__(self, w, steps):
        self.w = w; self.steps = steps; self.h = 46

    def wrap(self, *a): return (self.w, self.h + 8)

    def draw(self):
        c = self.canv
        n = len(self.steps)
        gap = 7
        bw = (self.w - gap * (n - 1)) / n
        x = 0
        for label, who in self.steps:
            if who == "you":
                fill, fg, line = INVERT, colors.white, INVERT
            elif who == "contract":
                fill, fg, line = PINE_WASH, PINE_DEEP, PINE_LINE
            else:
                fill, fg, line = SURFACE, INK, HAIR_S
            c.setFillColor(fill); c.setStrokeColor(line); c.setLineWidth(0.7)
            c.roundRect(x, 8, bw, self.h - 8, 4, stroke=1, fill=1)
            c.setFillColor(fg)
            c.setFont("Helvetica-Bold", 7.1)
            c.drawCentredString(x + bw / 2, 8 + (self.h - 8) / 2 + 2.5, label)
            c.setFont("Helvetica", 6.2)
            c.setFillColor(fg if who == "you" else INK_3)
            c.drawCentredString(x + bw / 2, 8 + (self.h - 8) / 2 - 7, who.upper())
            x += bw + gap


def cover(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(CANVAS)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)

    canvas.setFillColor(PINE_WASH)
    canvas.circle(PAGE_W + 30, PAGE_H - 20, 165, stroke=0, fill=1)

    canvas.setFillColor(INVERT)
    canvas.roundRect(M, PAGE_H - M - 34, 34, 34, 7, stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setFont(HEAD, 19)
    canvas.drawCentredString(M + 17, PAGE_H - M - 25, "C")
    canvas.setFillColor(INK)
    canvas.setFont(BOLD, 9.5)
    canvas.drawString(M + 44, PAGE_H - M - 22, "C O V E N A N T")

    canvas.setFont(HEAD, 33)
    canvas.setFillColor(INK)
    canvas.drawString(M, PAGE_H - 168, "Technical")
    canvas.drawString(M, PAGE_H - 205, "Documentation")

    canvas.setStrokeColor(PINE)
    canvas.setLineWidth(2.2)
    canvas.line(M, PAGE_H - 226, M + 64, PAGE_H - 226)

    canvas.setFillColor(INK_2)
    canvas.setFont(BODY, 11.5)
    canvas.drawString(M, PAGE_H - 254, "An AI procurement agent whose spending ceiling is")
    canvas.drawString(M, PAGE_H - 271, "enforced by contract state, not by its prompt.")

    # A small mandate panel echoing the site's hero card.
    bx, by, bw, bh = M, 398, FW * 0.62, 122
    canvas.setFillColor(SURFACE); canvas.setStrokeColor(HAIR_S); canvas.setLineWidth(0.8)
    canvas.roundRect(bx, by, bw, bh, 7, stroke=1, fill=1)
    canvas.setFillColor(INK_3); canvas.setFont(BOLD, 7.4)
    canvas.drawString(bx + 16, by + bh - 22, "P E R - D E A L   C E I L I N G")
    canvas.setFillColor(INK); canvas.setFont(HEAD, 27)
    canvas.drawString(bx + 16, by + bh - 55, "$1,200")
    rows = [("$1,175", "settled", PINE, PINE_WASH), ("$1,250", "reverted", CRIMSON, colors.HexColor("#FBEDEF"))]
    ry = by + 26
    for amt, tag, fg, bg in rows:
        canvas.setFillColor(INK); canvas.setFont(BOLD, 9)
        canvas.drawString(bx + 16, ry, amt)
        tw = canvas.stringWidth(tag, BOLD, 6.6) + 12
        canvas.setFillColor(bg); canvas.roundRect(bx + 74, ry - 3, tw, 13, 6, stroke=0, fill=1)
        canvas.setFillColor(fg); canvas.setFont(BOLD, 6.6)
        canvas.drawCentredString(bx + 74 + tw / 2, ry + 1, tag)
        ry -= 20

    canvas.setStrokeColor(HAIR_S); canvas.setLineWidth(0.7)
    canvas.line(M, 150, PAGE_W - M, 150)
    canvas.setFillColor(INK); canvas.setFont(BOLD, 9)
    canvas.drawString(M, 130, "Team Nexara9")
    canvas.setFillColor(INK_2); canvas.setFont(BODY, 9)
    canvas.drawString(M, 114, "M. Navya, 124CS0001   ·   Sujal Negi, 123ME0023   ·   IIITDM Kurnool")
    canvas.drawString(M, 99, "RizeOS Hackathon, AI Track")
    canvas.setFillColor(INK_3); canvas.setFont(BODY, 8.2)
    canvas.drawString(M, 74, "github.com/sujal128005/Covenant   ·   covenant-j1op.onrender.com")
    canvas.restoreState()


def body_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(CANVAS)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    canvas.setFillColor(INK_3)
    canvas.setFont(BODY, 7.4)
    canvas.drawString(M, 12 * mm, "Covenant  ·  Technical Documentation")
    canvas.drawRightString(PAGE_W - M, 12 * mm, str(canvas.getPageNumber() - 1))
    canvas.setStrokeColor(HAIR)
    canvas.setLineWidth(0.5)
    canvas.line(M, 15 * mm, PAGE_W - M, 15 * mm)
    canvas.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=M, rightMargin=M, topMargin=M,
                      bottomMargin=21 * mm, title="Covenant Technical Documentation",
                      author="Nexara9", subject="AI procurement under enforced spending authority")
doc.addPageTemplates([
    PageTemplate(id="cover", frames=[Frame(M, M, FW, PAGE_H - 2 * M, id="c")], onPage=cover),
    PageTemplate(id="body", frames=[Frame(M, 21 * mm, FW, PAGE_H - M - 21 * mm, id="b")], onPage=body_page),
])

story.append(NextPageTemplate("body"))
story.append(PageBreak())

# ------------------------------------------------------------------ 1
h1("1. Executive summary")
lead("Covenant is a procurement agent that takes a plain-language sourcing request, screens a "
     "supplier catalogue against it, negotiates in parallel with the suppliers that qualify, "
     "recommends one deal and settles payment through an escrow contract. It does all of that "
     "on its own.")
p("The one thing it cannot do is decide how much it is allowed to spend. That figure is written "
  "into contract storage by the buyer, and the contract checks it on every purchase. The agent can "
  "be wrong, confused or actively manipulated, and the ceiling still holds.")
pull("The agent can negotiate the deal. It cannot change what it is allowed to spend.")
p("The product runs end to end with no external services: an in-process EVM, a seeded supplier "
  "catalogue and a deterministic procurement engine. A language model is optional and is used only "
  "to reword explanations that are already correct.")

h1("2. Problem statement")
p("Autonomous agents are being given real payment authority faster than the controls around them "
  "are being built. An agent that sources and pays is exposed to supplier text it did not write, "
  "catalogue data it cannot verify, and a model whose behaviour changes between versions.")
p("The usual defence is an instruction: <i>you must never spend more than $1,200</i>. That "
  "instruction arrives through the same channel as the attack, is interpreted by the same model the "
  "attack is targeting, and produces no signal when it fails. It is a request, not a control.")
h2("What has to be true instead")
p("An agent that has been fully compromised, in the sense that an attacker controls every "
  "instruction it receives and every transaction it signs, still must not be able to move more than "
  "the buyer's per-deal ceiling. That has to hold without any check in the application layer, "
  "because the application layer is not the thing enforcing it.")

h1("3. Proposed solution")
p("Covenant separates the party that negotiates from the party that authorises. The buyer writes a "
  "per-deal ceiling into the escrow contract. The agent works beneath it and never holds the pen.")
table([
    ["Identity", "Holds", "Can do"],
    ["Buyer", "Account 0", "Set the ceiling, fund escrow, confirm delivery, release payment."],
    ["Agent", "Account 10", "Screen, negotiate, recommend, submit purchases under the ceiling."],
], [24 * mm, 24 * mm, FW - 48 * mm])
p("The separation is structural rather than procedural. The escrow contract writes an agent policy "
  "keyed on the caller:")
code("function setAgentPolicy(address agent, uint128 maxPerDeal,\n"
     "                       uint128 maxTotal, uint64 expiry) external {\n"
     "    // the record written is always policies[msg.sender]\n"
     "}")
p("Because the record is keyed on <font face='Courier' size='8.6'>msg.sender</font>, the only "
  "policy the agent can write is its own. There is no argument it can pass and no sequence of calls "
  "it can make that reaches the buyer's record. This is not an authorisation check that might "
  "contain a bug; the buyer's policy is not addressable from the agent's account.")
p("The demo shows this directly. One button lets the agent raise its own cap to $1,000,000. It "
  "succeeds, and the agent's own policy genuinely changes. The next spend is still rejected, "
  "because <font face='Courier' size='8.6'>createDeal</font> reads the buyer's record.")

h1("4. Product overview")
p("The interface is a single scrolling desk. Each stage writes its result beneath the last, and "
  "the view follows the agent while it works. The run stops before money moves.")
table([
    ["Component", "Path", "Responsibility"],
    ["HTTP API", "`server/index.js`", "23 routes. Orchestrates the run; holds no authority of its own."],
    ["Procurement engine", "`server/engine/`", "parse, match, negotiate, recommend. Deterministic, no I/O."],
    ["Chain harness", "`server/chain.js`", "In-process EVM, 32 accounts, contract deployment and wiring."],
    ["Contracts", "`contracts/`", "ProcurementEscrow, SupplierRegistry, MockUSDC."],
    ["Documents", "`server/documents.js`", "Agreements and settlement records from canonical state."],
    ["PDF", "`server/pdf.js`", "pdfkit, server side, deterministic bytes."],
    ["Explanation", "`server/counsel.js`", "Answers questions. Zero imports by design."],
    ["Decision briefs", "`server/decisionbrief.js`", "Pre-decision summaries. Zero imports by design."],
    ["Input repair", "`server/normalize.js`", "Typo and speech correction against a closed vocabulary."],
    ["Model layer", "`server/grok.js`", "Optional, provider agnostic. Never computes."],
    ["Workspace", "`server/workspace.js`", "Per-tab isolation of off-chain session state."],
    ["Frontend", "`web/src/`", "React 18 and Vite. Hand-written CSS design system."],
], [24 * mm, 41 * mm, FW - 65 * mm])

h1("5. Core workflow")
story.append(Flow(FW, [
    ("Request", "you"), ("Requirements", "agent"), ("Suppliers", "agent"), ("Negotiation", "agent"),
    ("Recommend", "agent"), ("Approval", "you"), ("Escrow", "contract"), ("Settle", "contract"),
]))
cap("Four stages run without the buyer. One cannot happen without them. The last two are the contract's.")
p("Everything from parsing to the recommendation is autonomous. From the approval onward every "
  "step requires the buyer, and the last two are executed by the contract rather than by the "
  "application.")
h2("What each stage produces")
bullets([
    "<b>Request.</b> Plain language. The stated budget becomes the ceiling the contract will enforce.",
    "<b>Requirements.</b> Material, grade, quantity, budget, delivery window and certifications. A missing field stops the run and is named, rather than guessed.",
    "<b>Suppliers.</b> Every listing checked. A hard failure excludes the supplier and records which constraint caused it.",
    "<b>Negotiation.</b> Bounded alternating offers, in parallel, against reservation prices the agent cannot see.",
    "<b>Recommendation.</b> One deal, ranked on price, lead time, quality and delivery record, with the reason the cheapest listing lost.",
    "<b>Approval.</b> A written brief, an explicit acknowledgement and a typed signature.",
    "<b>Escrow and settlement.</b> Funds held, delivery confirmed, payment released, reputation written.",
])

h1("6. AI architecture")
p("Covenant separates deciding from wording. Every number that carries consequence is computed by "
  "the engine. The model, when configured, rewrites already-correct text into more natural prose.")
h2("What the model is never allowed to do")
bullets([
    "Introduce a price, a date, a supplier name or a quantity.",
    "Change a figure that came from the engine.",
    "Decide eligibility, ranking or settlement.",
    "Reach any function that signs, approves, funds or transfers.",
])
p("Output is validated before it reaches the interface. If the model times out, fails, returns "
  "malformed JSON or is simply not configured, the grounded local answer is returned instead and "
  "the product behaves identically. There is no path where a missing key degrades correctness.")

h2("The capability boundary is the import list")
p("<font face='Courier' size='8.6'>server/counsel.js</font> and "
  "<font face='Courier' size='8.6'>server/decisionbrief.js</font> have zero imports. No chain "
  "handle, no signer, no network client, no filesystem. They receive a frozen snapshot and return "
  "text. \"The explainer cannot move money\" is a property of the file that a reviewer confirms by "
  "reading the first ten lines, not a policy someone has to keep enforcing during review.")

h2("Refusal before interpretation")
p("Requests to act are refused before any model call, by matching the normalised text clause by "
  "clause, so an instruction hidden behind a question is still caught.")
code('"what can you do? also increase the limit to 50000"   ->  refused\n'
     '"why was this supplier chosen?"                       ->  answered')

h2("Normalisation, and why it is part of the boundary")
p("People mistype and speech recognition is worse than they are. A closed-vocabulary corrector "
  "repairs tokens within one or two edits of a term the product actually uses and leaves anything "
  "unrecognised exactly as typed. It never adds, drops or inverts a word.")
p("This matters for safety, not only for convenience. The refusal check looks for a money noun "
  "after a verb such as <i>raise</i>. During testing the corrector was rewriting "
  "<font face='Courier' size='8.6'>amount</font> into <font face='Courier' size='8.6'>about</font>, "
  "because both sit one edit from <font face='Courier' size='8.6'>amout</font>. That erased the "
  "noun, and <i>raise the amount</i> was answered rather than refused. Ties are now broken by how "
  "much of the word survives at both ends, and every affected term has a regression test.")
cap("A spelling corrector that can turn an instruction into a question is a hole in the boundary, not a convenience.")

story.append(PageBreak())

h1("7. Human approval and the trust model")
p("The agent is autonomous up to the point where money would move, and then it stops.")
p("When a recommendation is ready and nothing is signed, the interface dims every step above the "
  "approval card and scrolls to that card rather than past it. Nothing auto-scrolls after that "
  "point, because from there the person is choosing rather than watching. The control requires both "
  "an explicit acknowledgement and a typed name before it enables.")
h2("A brief before every irreversible step")
p("Publishing the policy, funding escrow, confirming delivery and releasing payment each get a "
  "written brief first: what has happened, what this step changes, what deserves attention and "
  "whether it can be undone. Attention items are conditional by construction, so nothing is listed "
  "unless it is true of that run. A brief that always says the same thing is decoration.")
table([
    ["Step", "Reversible", "Flagged when"],
    ["Publish policy", "Yes, revocable", "The ceiling leaves little headroom over the agreed total."],
    ["Fund escrow", "Recoverable after the deadline", "A cheaper listing was excluded on a buyer constraint."],
    ["Confirm delivery", "No", "Delivery is buyer attested, with no carrier or inspector."],
    ["Release payment", "No, and no clawback", "Always. Release is final."],
], [30 * mm, 40 * mm, FW - 70 * mm])

h1("8. Procurement and supplier engine")
p("Four pure modules with no network access, no model calls and no clock dependence beyond an "
  "injected date. Given the same brief and catalogue they produce the same result every time, which "
  "is what makes the figures in the agreement worth printing.")
h2("Screening")
p("Every listing is checked against the brief. Constraints divide into hard and soft. A hard "
  "failure excludes the supplier and records which constraint caused it, so the exclusion can be "
  "explained later. Soft failures survive into negotiation as things to bargain over. Price is "
  "negotiable; a certificate is not.")
h2("Catalogue")
p("15 suppliers across 13 countries, offering 39 listings in 13 materials, from PET resin and "
  "kraft paper through aluminium, steel, copper and silicone. 17 worked scenarios ship with the "
  "app, spanning packaging, metals, mechanical, electrical, electronics, medical and aerospace "
  "buying. The catalogue is seeded demo data rather than a live directory, and the product says so.")

h1("9. Negotiation")
p("Bounded alternating offers. Each supplier holds a private reservation price the agent cannot "
  "see. The agent opens below list, concedes on a schedule, and stops when either the supplier "
  "accepts or the next concession would breach the ceiling. Walking away is a normal outcome and "
  "appears in the record as one.")
p("The unit ceiling is derived from the stated budget, so the figure the agent negotiates against "
  "and the figure the contract enforces are the same number reached from the same source. In the "
  "worked example the agent opens at $2.20/kg against a $2.40 ceiling and settles at $2.35, three "
  "rounds, $1,175 against a $1,200 budget.")

h1("10. Blockchain and transaction layer")
p("Three contracts, compiled in process with solc 0.8.24 and deployed to an in-process EVM at boot.")
table([
    ["Contract", "Responsibility"],
    ["`ProcurementEscrow`", "Buyer ceiling, agent authorisation, deal creation, escrow settlement, access control."],
    ["`SupplierRegistry`", "Supplier reputation. Writes restricted to the escrow contract."],
    ["`MockUSDC`", "A local 6-decimal ERC-20 used for the demo."],
], [34 * mm, FW - 34 * mm])
h2("Custom errors")
table([
    ["Error", "Raised when"],
    ["`ExceedsPerDealCap(requested, cap)`", "A single deal exceeds the buyer's per-deal ceiling."],
    ["`ExceedsTotalCap(requested, remaining)`", "Cumulative spend would pass the buyer's total allowance."],
    ["`NotAuthorisedAgent(caller, expected)`", "An account other than the named agent attempts to spend."],
    ["`PolicyInactive()`", "No policy is live for this buyer."],
    ["`PolicyExpired()`", "The policy covering the purchase has passed its expiry."],
    ["`NotBuyer()`", "A non-buyer attempts a buyer-only step."],
    ["`SupplierNotRegistered()`", "The payee is not in the registry."],
    ["`BadState(found)`", "A lifecycle step is attempted out of order."],
    ["`Reentrancy()`", "A nested call re-enters a guarded function."],
], [56 * mm, FW - 56 * mm])

story.append(PageBreak())

h1("11. Data flow and workspace isolation")
p("Procurement state is commercially sensitive: the request typed, which suppliers were screened "
  "out and why, every negotiation turn, and the documents built from them. Each browser tab mints a "
  "workspace id and sends it with every request; the server keys session state on it, so one "
  "buyer's run is never served to another.")
p("This is isolation rather than authentication. There is nothing to log into and no credential is "
  "stored. The wallet gate binds the workspace to a connected address for people who want a private "
  "workspace; on this demo chain a single funded account still signs either way.")

h1("12. Security, safety and validation")
table([
    ["Protection", "Enforced by"],
    ["Spending ceiling", "`ProcurementEscrow.createDeal`"],
    ["Agent cannot widen the buyer ceiling", "Policy record keyed on `msg.sender`"],
    ["Only the authorised agent can spend", "`NotAuthorisedAgent`"],
    ["Reputation writes", "`SupplierRegistry`, restricted to the escrow contract"],
    ["Document values", "Derived from canonical server state"],
    ["Workspace isolation", "`server/workspace.js`"],
    ["Explanation layer cannot act", "No capability imports in `counsel.js`"],
    ["Instructions to act", "Refused clause by clause before any model call"],
    ["Model output", "Validated before display; local fallback on any failure"],
], [62 * mm, FW - 62 * mm])
p("The API is not the final authority for the spending limit. The contract is.")

h1("13. Interface and design system")
p("One hand-written CSS design system, no component library, with a semantic token layer that "
  "flips between light, dark and system.")
bullets([
    "<b>The island.</b> A capsule pinned to the top of the viewport that names the current phase, counts it, runs a clock and fills a bar. It opens to full width on a phase change and settles back to compact while work continues. Every figure on it is real.",
    "<b>The checkpoint.</b> The page dims every step above the approval card and will not scroll past it.",
    "<b>Rationale.</b> A drawer answering questions about the run by text or voice from a frozen snapshot. Read only, enforced in code.",
    "<b>Themes.</b> Light, dark and system. Every foreground and background pair in both themes measures at or above the WCAG AA ratio.",
    "<b>Command palette.</b> Ctrl K, Cmd K or forward slash.",
])
h2("Responsive behaviour")
p("The layout is reflowed rather than scaled. Below 860px the sidebar becomes a top bar and the "
  "stage rail becomes its own horizontal scroller so the theme control stays reachable. Below 720px "
  "the voice dock goes full width and the Rationale control lifts above it. Modals fill the screen "
  "rather than floating inside it.")
cap("No horizontal overflow and no escaping elements measured at 1440, 1200, 900, 720, 620 or 390 pixels, on the homepage, the wallet gate and the application.")

h1("14. Testing")
p("The security claim is worth exactly what the tests behind it are worth. Two suites run against "
  "the same code from different angles.")
table([
    ["Suite", "Count", "Covers"],
    ["Smart contracts", "23", "Escrow lifecycle, policy limits, expiry, revocation, reputation, access control."],
    ["Red team, authority", "13", "Cross-buyer spending, agent replacement, stale policies, invalid deals."],
    ["Requirement parsing", "4", "Field extraction, missing-field reporting."],
    ["Supplier matching", "3", "Hard exclusion with a stated cause, soft constraints surviving."],
    ["Negotiation", "6", "Concession bounds, walk-away, ceiling never breached."],
    ["Recommendation", "3", "Weighted ranking, the cheapest listing losing correctly."],
    ["Adversarial input", "4", "Prompt injection, hostile supplier text, manipulated figures."],
    ["Capability boundary", "18", "Refusals, frozen snapshots, fallback behaviour."],
    ["Compound input", "3", "Instructions concealed inside questions."],
    ["Imperfect input", "7", "Typos, speech noise, real words the corrector must not rewrite."],
    ["LLM pipeline", "7", "Timeouts, HTTP failures, malformed completions, latency reporting."],
    ["Documents and PDF", "15", "Binary validity, metadata, signing, hashing, pagination."],
], [40 * mm, 15 * mm, FW - 55 * mm])
p("<b>106 unit and contract tests.</b> A second suite, "
  "<font face='Courier' size='8.6'>npm run sweep</font>, adds <b>101 checks</b> against a live "
  "server, walking all 23 endpoints in the order a person uses them.")
h2("What the second suite caught")
p("Isolated tests miss state. The sweep found that a second sourcing run in the same workspace "
  "inherited the previous run's settlement facts, signature and deal id, so a fresh unfunded run "
  "presented an agreement stamped as already signed and already funded while asking to be signed.")
p("It also caught one of its own assertions being vacuous: a ceiling check read a field the "
  "negotiation shape does not carry, so it passed without ever comparing a number. It now checks "
  "that no offer the agent makes crosses the unit ceiling, which is the narrower thing that has to "
  "hold, since a supplier is free to ask for anything.")

story.append(PageBreak())

h1("15. Limitations")
p("Naming what is simulated is what makes the enforced part credible.")
table([
    ["Real", "Simulated or demo only"],
    ["Contract enforcement of the ceiling", "Supplier catalogue, seeded rather than a live directory"],
    ["Transactions, reverts and custom errors", "Supplier negotiation behaviour"],
    ["Escrow custody and release", "Delivery confirmation, attested by the buyer"],
    ["Reputation written by the contract", "MockUSDC in place of a live stablecoin"],
    ["Document generation, hashing, versioning", "In-process EVM in place of a public network"],
], [FW / 2, FW / 2])
bullets([
    "The signature records a name, a timestamp and a document hash. It is not a legally binding electronic signature, and the interface says so where a person could otherwise assume it is.",
    "A deployment currently shares one on-chain buyer identity. Workspaces isolate off-chain state per browser tab.",
    "There is no oracle for delivery. The buyer's confirmation is an assertion, and the brief before that step says as much.",
    "The hosted demo runs on a free instance and may take up to a minute to wake.",
])

h1("16. Future scope")
bullets([
    "Oracle-backed delivery verification, so the chain records arrival rather than an assertion about it.",
    "Per-workspace buyer wallets, so isolation extends to the on-chain identity.",
    "Supplier-side agents, so both parties negotiate under enforced authority.",
    "Public-network deployment through <font face='Courier' size='8.6'>RPC_URL</font>, which the codebase already supports.",
])

h1("17. Conclusion")
p("Covenant is a working answer to a narrow question: how do you let an agent spend money without "
  "trusting it not to overspend. The answer here is to move the limit out of the agent's reach "
  "entirely, into contract state the agent has no route to modify, and then to let the agent try.")
p("Everything else in the product follows from that decision. The engine is deterministic so the "
  "figures in the agreement can be trusted. The explanation layer has no imports so it cannot act. "
  "The run stops before money moves so a person decides. The tests exist because a security claim "
  "with nothing behind it is a slogan.")
pull("The limit is contract state. The agent cannot raise it.")

doc.build(story)
print("written", OUT)
