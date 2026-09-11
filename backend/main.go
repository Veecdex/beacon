package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
)

// App holds everything handlers need, passed around instead of using package
// globals.
type App struct {
	DB        *pgxpool.Pool
	JWTSecret []byte
	Hub       *Hub
}

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required (your Neon connection string)")
	}
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		log.Fatal("JWT_SECRET is required (any long random string)")
	}
	allowedOrigin := os.Getenv("ALLOWED_ORIGIN")
	if allowedOrigin == "" {
		allowedOrigin = "*"
		log.Println("warning: ALLOWED_ORIGIN not set, allowing all origins — set it to your Vercel URL in production")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	pool, err := connectDB(databaseURL)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer pool.Close()

	app := &App{DB: pool, JWTSecret: []byte(jwtSecret), Hub: newHub()}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware(allowedOrigin))

	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "beacon backend is running"})
	})

	r.Post("/api/auth/signup", app.handleSignup)
	r.Post("/api/auth/login", app.handleLogin)

	r.Group(func(pr chi.Router) {
		pr.Use(app.authMiddleware)
		pr.Get("/api/me", app.handleMe)
		pr.Post("/api/rooms", app.handleCreateRoom)
		pr.Post("/api/rooms/join", app.handleJoinRoom)
		pr.Get("/api/rooms/{code}", app.handleGetRoom)
	})

	// Sits outside authMiddleware — see the comment on handleWS for why.
	r.Get("/api/rooms/{code}/ws", app.handleWS)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 0, // a websocket connection needs to stay open indefinitely
		IdleTimeout:  120 * time.Second,
	}

	log.Printf("beacon backend listening on :%s", port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
