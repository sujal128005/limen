"""Material and specification catalogue for v1 (resins, metals, packaging).

Used to (a) know which specifications decide a purchase, so a missing one is
flagged instead of guessed, and (b) sanity-check extracted numbers. Extend by
adding entries; nothing else in the engine hard-codes a material.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class AttrDef:
    unit: str | None = None
    choices: tuple[str, ...] = ()     # non-empty -> categorical attribute
    lo: float | None = None           # plausible range for numeric sanity checks
    hi: float | None = None
    critical: bool = False            # purchase cannot be specified without it
    capability: bool = False          # True: supplier states what it CAN MAKE (e.g. thickness 2-6 mm), so the
                                      # buyer's value must fall inside the supplier's range. False: a material
                                      # PROPERTY (e.g. MFI), so the supplier's range must fall inside the buyer's.
    question: str = ""


@dataclass(frozen=True)
class MaterialDef:
    category: str
    uom: str
    aliases: tuple[str, ...]
    attrs: dict[str, AttrDef] = field(default_factory=dict)


MATERIALS: dict[str, MaterialDef] = {
    "HDPE": MaterialDef("RESIN", "KG", ("hdpe", "high density polyethylene"), {
        "grade_type": AttrDef(choices=("blow_moulding", "injection_moulding", "film", "pipe", "raffia"), critical=True,
                              question="Which HDPE grade type is needed (blow moulding, injection moulding, film, pipe, raffia)?"),
        "mfi_g_10min": AttrDef("g/10min", lo=0.01, hi=100, critical=True,
                               question="What melt flow index (MFI) range is acceptable?"),
        "density_g_cc": AttrDef("g/cc", lo=0.93, hi=0.97),
    }),
    "PP": MaterialDef("RESIN", "KG", ("pp", "polypropylene"), {
        "grade_type": AttrDef(choices=("injection_moulding", "raffia", "film", "blow_moulding"), critical=True,
                              question="Which PP grade type is needed (injection moulding, raffia, film, blow moulding)?"),
        "mfi_g_10min": AttrDef("g/10min", lo=0.1, hi=100, critical=True,
                               question="What melt flow index (MFI) range is acceptable?"),
    }),
    "LLDPE": MaterialDef("RESIN", "KG", ("lldpe", "linear low density polyethylene"), {
        "grade_type": AttrDef(choices=("film", "injection_moulding", "roto_moulding"), critical=True,
                              question="Which LLDPE grade type is needed (film, injection moulding, roto moulding)?"),
        "mfi_g_10min": AttrDef("g/10min", lo=0.1, hi=100, critical=True,
                               question="What melt flow index (MFI) range is acceptable?"),
    }),
    "HR_COIL": MaterialDef("METAL", "KG", ("hr coil", "hot rolled coil", "hot rolled steel", "hr steel"), {
        "steel_grade": AttrDef(choices=("IS2062_E250", "IS2062_E350", "IS10748", "SAE1010"), critical=True,
                               question="Which steel grade is required (for example IS 2062 E250)?"),
        "thickness_mm": AttrDef("mm", capability=True, lo=1.0, hi=25.0, critical=True, question="What thickness (mm) is required?"),
        "width_mm": AttrDef("mm", capability=True, lo=600, hi=2100),
    }),
    "CR_SHEET": MaterialDef("METAL", "KG", ("cr sheet", "cold rolled sheet", "crca", "cold rolled steel"), {
        "steel_grade": AttrDef(choices=("IS513_CR1", "IS513_CR2", "IS513_CR3", "IS513_CR4"), critical=True,
                               question="Which steel grade is required (for example IS 513 CR2)?"),
        "thickness_mm": AttrDef("mm", capability=True, lo=0.2, hi=4.0, critical=True, question="What thickness (mm) is required?"),
        "width_mm": AttrDef("mm", capability=True, lo=500, hi=1600),
    }),
    "ALUMINIUM_INGOT": MaterialDef("METAL", "KG", ("aluminium ingot", "aluminum ingot", "al ingot"), {
        "purity_pct": AttrDef("%", lo=90.0, hi=99.99, critical=True, question="What minimum purity (%) is required?"),
    }),
    "CORRUGATED_BOX": MaterialDef("PACKAGING", "PCS", ("corrugated boxes", "corrugated box", "corrugated cartons", "corrugated carton", "carton boxes", "carton box", "cartons"), {
        "ply": AttrDef("ply", capability=True, lo=3, hi=9, critical=True, question="How many ply (3, 5 or 7)?"),
        "length_mm": AttrDef("mm", capability=True, lo=50, hi=2500, critical=True, question="What are the box dimensions (L x W x H in mm)?"),
        "width_mm": AttrDef("mm", capability=True, lo=50, hi=2500, critical=True, question="What are the box dimensions (L x W x H in mm)?"),
        "height_mm": AttrDef("mm", capability=True, lo=20, hi=2500, critical=True, question="What are the box dimensions (L x W x H in mm)?"),
        "bursting_strength_kg_cm2": AttrDef("kg/cm2", lo=4, hi=30),
    }),
    "PET": MaterialDef("RESIN", "KG", ("pet resin", "pet chips", "pet granules", "polyethylene terephthalate", "pet"), {
        "grade_type": AttrDef(choices=("bottle", "film", "fibre", "sheet"), critical=True,
                              question="Which PET grade is needed (bottle, film, fibre or sheet)?"),
        "iv_dl_g": AttrDef("dl/g", lo=0.5, hi=1.2,
                           question="What intrinsic viscosity (IV) range is acceptable?"),
    }),
    "BOPP_FILM": MaterialDef("PACKAGING", "KG", ("bopp film", "bopp"), {
        "thickness_micron": AttrDef("micron", capability=True, lo=8, hi=80, critical=True, question="What film thickness (micron) is required?"),
        "width_mm": AttrDef("mm", capability=True, lo=100, hi=8700),
    }),
}

# canonical name -> spellings found in tenders
CERTIFICATIONS: dict[str, tuple[str, ...]] = {
    "BIS": ("bis", "isi mark", "bureau of indian standards"),
    "ISO 9001": ("iso 9001", "iso9001", "iso-9001"),
    "ISO 14001": ("iso 14001", "iso14001", "iso-14001"),
    "IATF 16949": ("iatf 16949", "iatf16949", "ts 16949"),
    "FSC": ("fsc",),
    "FOOD CONTACT": ("food contact", "food-contact", "food grade", "food-grade", "fda food", "fssai"),
}
