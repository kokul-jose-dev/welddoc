import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    SQLALCHEMY_DATABASE_URI = (
        "mssql+pyodbc:///?odbc_connect="
        + os.getenv("AZURE_SQL_CONNECTION_STRING", "")
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,
        "pool_recycle": 300,
    }
    SECRET_KEY = os.getenv("FLASK_SECRET_KEY", "change-me-in-production")
    AZURE_CLIENT_ID = os.getenv("AZURE_CLIENT_ID", "")
    AZURE_TENANT_ID = os.getenv("AZURE_TENANT_ID", "")
    AZURE_CLIENT_SECRET = os.getenv("AZURE_CLIENT_SECRET", "")
    SHAREPOINT_HOST = os.getenv("SHAREPOINT_HOST", "")
    SHAREPOINT_SITE_PATH = os.getenv("SHAREPOINT_SITE_PATH", "")
