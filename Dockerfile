FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY requirements-yandex.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements-yandex.txt
COPY . .

ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
