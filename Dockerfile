FROM node:20-alpine

WORKDIR /app

# 零运行时依赖：直接复制源码与测试
COPY package.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.js"]
