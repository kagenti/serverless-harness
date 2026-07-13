# RC1-2 (Hop 2) plain-HTTP echo target: reflects the received Authorization header so the live
# smoke can confirm AB2 injected the real egress credential. Self-built (dev.local/echo-target:rc1)
# and kind-loaded — no Docker Hub pull by the cluster.
FROM node:20-alpine
COPY echo.js /echo.js
EXPOSE 8080
# Run as the non-root uid-1000 `node` user shipped by node:20-alpine (matches echo.js's
# "non-root" note). The server binds :8080, so no privileged port / root is needed.
USER node
CMD ["node", "/echo.js"]
