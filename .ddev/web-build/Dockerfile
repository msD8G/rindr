ARG BASE_IMAGE
FROM $BASE_IMAGE

RUN sudo apt-get update

# 1. Bun installieren und für alle verfügbar machen
RUN curl -fsSL https://bun.sh/install | bash && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    chmod +x /usr/local/bin/bun

# 2. Claude Code über npm installieren (umgeht das Rechte-Problem komplett)
RUN npm install -g @anthropic-ai/claude-code