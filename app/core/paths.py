from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1]  # app/
BASE_DIR = APP_DIR.parent
TEMPLATES_DIR = APP_DIR / "templates"
STATIC_DIR = APP_DIR / "static"
