FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# Listen on all interfaces inside the container. Set OFFICE_PASSWORD when you run it.
ENV HOST=0.0.0.0 PORT=3000 OFFICE_DATA=/data/office.json
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
