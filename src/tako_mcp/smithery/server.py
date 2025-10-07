from ..main import mcp
from pydantic import BaseModel
from smithery.decorators import smithery

class ConfigSchema(BaseModel):
    takoApiKey: str

@smithery.server(config_schema=ConfigSchema)
def create_server():
    return mcp