FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000 DATA_DIR=/data/db UPLOAD_DIR=/data/uploads
EXPOSE 3000
CMD ["node", "server.js"]
