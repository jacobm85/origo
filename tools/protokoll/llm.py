"""LLM-baserad extraktion av kommun-protokoll via Anthropic Claude API.

En adapter for ALLA kommuner istallet for en parser per CMS - Claude lases PDF:en
direkt och returnerar strukturerade beslut i JSON via tool use med strict mode.

Cost (Opus 4.7, ~10-page protokoll):
  - System prompt: ~800 tokens (cached efter forsta anropet)
  - PDF input:     ~10 000 tokens  ≈ $0.05
  - Output JSON:    ~1 500 tokens  ≈ $0.04
  Per protokoll:    ~$0.09

290 kommuner x 10 protokoll/ar ≈ $260/ar.

Kraver:
  pip install anthropic pypdf
  ANTHROPIC_API_KEY satt i env (eller passa explicit till LLMExtractor)
"""

from __future__ import annotations

import base64
import os
from typing import Any

try:
    import anthropic
except ImportError:
    anthropic = None  # type: ignore


# System prompten ar STABIL och cachas - andra inte mellan korningar utan att veta
# att hela cachen invalideras. Render order: tools -> system -> messages, sa cachen
# omfattar bade tool-definitionen och systemtexten.
SYSTEM_PROMPT = """\
Du är en expert på att läsa svenska kommun-mötesprotokoll och extrahera \
strukturerad information om platsbundna beslut.

OMRÅDE
Du läser typiskt protokoll från Miljö- och byggnadsnämnden, Samhällsbyggnads\
nämnden, Stadsbyggnadsnämnden eller liknande organ. Protokollen kommer från \
alla Sveriges 290 kommuner och har olika layouter (SiteVision, Public360, \
EpiServer, eller egna CMS), olika rubriksättning ("INNEHÅLLSFÖRTECKNING", \
"Ärendelista", "Föredragningslista", "Dagordning") och olika grad av detalj.

UPPGIFT
Identifiera ALLA paragrafer (§ N) som rör en SPECIFIK GEOGRAFISK PLATS i \
kommunen — dvs där en fastighet, adress, kvarter eller område är inblandat. \
Anropa verktyget record_decisions EN gång med ALLA hittade ärenden i en lista.

INKLUDERA
- Bygglov (alla typer: nybyggnad, tillbyggnad, ombyggnad, tidsbegränsat)
- Detaljplaneärenden (samrådsyttranden, antagande, ändringar, planbesked)
- Förhandsbesked
- Strandskyddsdispens
- Tillsyn enligt plan- och bygglagen
- Marklov, rivningslov
- Avloppsdispens, enskilt avlopp, slamtömning
- Täkt- och gruvärenden
- Bostadsanpassningsbidrag (med fastighet)
- Förelägganden / lovförelägganden / förbud knutna till en plats

UTESLUT
- Administrativa beslut (delegationsordning, taxor, internkontroll, reglementen)
- Ekonomi/budget/verksamhetsuppföljning utan plats
- Möteslogistik (justering, närvarolistor, redovisning av delegationsbeslut, \
kurser/konferenser, val av justerare, ärendeuppföljning)
- Information från förvaltningschef/avdelningschef
- Yttranden över remisser som inte är geografiska

FÄLT
Extrahera följande för varje relevant ärende:
- paragraph: § numret (heltal)
- title: ärendets fullständiga titel som den står i protokollet
- type: en av "bygglov" | "detaljplan" | "forhandsbesked" | \
"samradsyttrande" | "strandskyddsdispens" | "tillsyn" | "marklov" | \
"rivningslov" | "avlopp" | "takt_gruv" | "bostadsanpassning" | \
"forelaggande" | "annat"
- fastighet: fastighetsbeteckning som "Bergnäset 1:42" eller "DUNDRET 5:109" \
om angiven. Tom sträng om ej angiven.
- address: postadress (gata + nummer + ort) om angiven. Tom sträng annars.
- applicant: sökande OM organisation/företag (t.ex. "Boliden Mineral AB"). \
ALDRIG namn på privatpersoner — det är GDPR-skyddat. Tom sträng om saknas \
eller om sökande är privatperson.
- decision: en av "beviljat" | "avslag" | "forhandsbesked_positivt" | \
"forhandsbesked_negativt" | "atertaget" | "atervisat" | "tillsynsarende" | \
"pagaende" | "ej_angivet"
- summary: en (1) mening på svenska som sammanfattar vad ärendet handlar om

VIKTIGT
- Inkludera ALDRIG personnamn för privatpersoner i något fält.
- Om en fastighetsbeteckning står i titeln, extrahera den även om resten är \
knapphändig — många protokoll lägger fastigheten där.
- Om protokollet är ett "samlingsprotokoll" (bara cover + agenda + valda §§), \
extrahera ALLA paragrafer från agendan som matchar — du behöver inte se den \
fulla brödtexten.
- Kvalitet > kvantitet: om du är osäker om något är platsrelevant, INKLUDERA \
det hellre än att utesluta — användaren filtrerar i nästa steg.
- Returnera tom lista [] om PDF:en inte innehåller några platsrelevanta beslut \
alls — bättre tom lista än hittepå.
"""


# Strikt JSON-schema som Claude tvingas anropa via tool use.
RECORD_DECISIONS_TOOL: dict[str, Any] = {
    "name": "record_decisions",
    "description": (
        "Registrera alla platsrelevanta beslut från protokollet. "
        "Anropa EN gång med hela listan."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "decisions": {
                "type": "array",
                "description": "Lista över alla platsrelevanta beslut i protokollet",
                "items": {
                    "type": "object",
                    "properties": {
                        "paragraph": {
                            "type": "integer",
                            "description": "Paragrafnummer (§)",
                        },
                        "title": {
                            "type": "string",
                            "description": "Ärendets fullständiga titel",
                        },
                        "type": {
                            "type": "string",
                            "enum": [
                                "bygglov", "detaljplan", "forhandsbesked",
                                "samradsyttrande", "strandskyddsdispens",
                                "tillsyn", "marklov", "rivningslov", "avlopp",
                                "takt_gruv", "bostadsanpassning",
                                "forelaggande", "annat",
                            ],
                        },
                        "fastighet": {
                            "type": "string",
                            "description": "Fastighetsbeteckning om angiven (t.ex. 'Bergnäset 1:42'). Tom sträng annars.",
                        },
                        "address": {
                            "type": "string",
                            "description": "Postadress om angiven. Tom sträng annars.",
                        },
                        "applicant": {
                            "type": "string",
                            "description": "Sökande organisation/företag. Tom sträng om privatperson eller saknas.",
                        },
                        "decision": {
                            "type": "string",
                            "enum": [
                                "beviljat", "avslag", "forhandsbesked_positivt",
                                "forhandsbesked_negativt", "atertaget",
                                "atervisat", "tillsynsarende", "pagaende",
                                "ej_angivet",
                            ],
                        },
                        "summary": {
                            "type": "string",
                            "description": "En mening som sammanfattar ärendet",
                        },
                    },
                    "required": [
                        "paragraph", "title", "type", "fastighet", "address",
                        "applicant", "decision", "summary",
                    ],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["decisions"],
        "additionalProperties": False,
    },
}


class LLMExtractor:
    """Vrapper runt Anthropic Claude API for protokoll-extraktion.

    Anvanding:
        extractor = LLMExtractor()
        decisions = extractor.extract(pdf_bytes, kommun="Lulea", lan="Norrbottens lan")
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "claude-opus-4-7",
        max_tokens: int = 16000,
    ) -> None:
        if anthropic is None:
            raise RuntimeError(
                "anthropic package not installed. Run: pip install anthropic"
            )
        # If api_key is None the SDK reads ANTHROPIC_API_KEY from the environment.
        # Reject obvious placeholders so we fail fast instead of leaking a 401.
        key = api_key if api_key is not None else os.environ.get("ANTHROPIC_API_KEY", "")
        if not key or key.startswith("REPLACE_") or key == "your-key-here":
            raise RuntimeError(
                "ANTHROPIC_API_KEY ar inte satt (eller ar fortfarande en platshallare). "
                "Satt den i env eller passa api_key till LLMExtractor."
            )
        self.client = anthropic.Anthropic(api_key=key)
        self.model = model
        self.max_tokens = max_tokens

    def extract(
        self,
        pdf_bytes: bytes,
        kommun: str,
        lan: str,
        date: str | None = None,
    ) -> list[dict[str, Any]]:
        """Skicka PDF till Claude och fa en lista beslut tillbaka.

        kommun/lan/date anvands i user-prompten sa Claude vet vilken kommun
        och lan beslut tillhor (anvands inte for filtrering, bara for kontext).

        Returnerar tom lista om protokollet inte innehaller nagra platsrelevanta
        beslut. Returnerar tom lista vid API-fel (loggar pa stderr).
        """
        b64 = base64.standard_b64encode(pdf_bytes).decode("ascii")
        user_text = (
            f"Kommun: {kommun}\n"
            f"Län: {lan}\n"
            + (f"Mötesdatum: {date}\n" if date else "")
            + "\nLäs protokoll-PDF:en och anropa record_decisions med "
            "alla platsrelevanta paragrafer."
        )

        response = self.client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            thinking={"type": "adaptive"},
            tools=[RECORD_DECISIONS_TOOL],
            tool_choice={"type": "tool", "name": "record_decisions"},
            system=[
                {
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "document",
                            "source": {
                                "type": "base64",
                                "media_type": "application/pdf",
                                "data": b64,
                            },
                        },
                        {"type": "text", "text": user_text},
                    ],
                }
            ],
        )

        for block in response.content:
            if getattr(block, "type", None) == "tool_use" and block.name == "record_decisions":
                decisions = block.input.get("decisions") or []
                # Stamp kommun/lan ON the records here (not in the schema, since
                # the model would re-state what we already told it - wastes tokens).
                for d in decisions:
                    d["kommun"] = kommun
                    d["lan"] = lan
                    if date:
                        d["date"] = date
                return decisions

        return []
