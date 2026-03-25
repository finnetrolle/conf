FROM gradle:8.10.2-jdk21 AS build
WORKDIR /app

COPY settings.gradle.kts build.gradle.kts ./
COPY src ./src

RUN gradle --no-daemon test installDist

FROM eclipse-temurin:21-jre
WORKDIR /app

COPY --from=build /app/build/install/server /app

EXPOSE 8080

ENTRYPOINT ["/app/bin/server"]

