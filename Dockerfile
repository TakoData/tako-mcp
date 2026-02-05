FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY pyproject.toml .
RUN pip install --no-cache-dir \
    mcp \
    httpx \
    uvicorn[standard] \
    pydantic \
    "starlette>=0.50.0" \
    mcp-ui-server

# Copy source code
COPY src/ src/

# Expose default port
EXPOSE 8001

# Environment variables (override at runtime)
ENV TAKO_API_URL=https://api.trytako.com
ENV PUBLIC_BASE_URL=https://trytako.com
ENV PORT=8001
ENV HOST=0.0.0.0

# Run the server
CMD ["python", "-m", "tako_mcp.server"]
