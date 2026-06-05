# data-refresh — lätt container som kör de periodiska data-generatorerna
# (Node + Python, endast standardbibliotek). tools/ och data/ bind-mountas in
# vid körning (se docker-compose.yml) så att skript- och dataändringar slår
# igenom utan ombyggnad.
FROM node:lts-alpine
RUN apk add --no-cache python3
WORKDIR /app
COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
