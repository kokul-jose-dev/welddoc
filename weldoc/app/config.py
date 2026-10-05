import os
from dotenv import load_dotenv

load_dotenv(override=True)


class Config:
    SQLALCHEMY_DATABASE_URI = (
        "mssql+pyodbc:///?odbc_connect="
        + os.getenv("AZURE_SQL_CONNECTION_STRING", "")
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,
        "pool_recycle": 300,
        "pool_size": 10,
        "max_overflow": 20,
    }
    SECRET_KEY = os.getenv("FLASK_SECRET_KEY", "change-me-in-production")
    AZURE_CLIENT_ID = os.getenv("AZURE_CLIENT_ID", "")
    AZURE_TENANT_ID = os.getenv("AZURE_TENANT_ID", "")
    AZURE_CLIENT_SECRET = os.getenv("AZURE_CLIENT_SECRET", "")
    SHAREPOINT_HOST = os.getenv("SHAREPOINT_HOST", "")
    SHAREPOINT_SITE_PATH = os.getenv("SHAREPOINT_SITE_PATH", "")
    # Global WAZ folder: every WAZ certificate uploaded at project level is also kept here,
    # under the same file name (app/global_waz.py). Empty folder = switched off.
    # Who may read the event log: comma-separated logins (app/event_log.py)
    SHAREPOINT_GLOBAL_WAZ_HOST = os.getenv("SHAREPOINT_GLOBAL_WAZ_HOST", "")
    SHAREPOINT_GLOBAL_WAZ_SITE = os.getenv("SHAREPOINT_GLOBAL_WAZ_SITE", "")
    SHAREPOINT_GLOBAL_WAZ_FOLDER = os.getenv("SHAREPOINT_GLOBAL_WAZ_FOLDER", "")
    SHAREPOINT_WELDER_FOLDER = os.getenv("SHAREPOINT_WELDER_FOLDER", "General/1_QMS ISO 9001_2015/4_Nachweisend/3.2_Personal & Ausbildung/Schweissprüfungen")
