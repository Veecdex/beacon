package main

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

type signupRequest struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Photo    string `json:"photo"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type authResponse struct {
	Token string     `json:"token"`
	User  PublicUser `json:"user"`
}

func (a *App) handleSignup(w http.ResponseWriter, r *http.Request) {
	var req signupRequest
	if err := readJSON(r, &req); err != nil {
		errorJSON(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

	if req.Name == "" || req.Email == "" || len(req.Password) < 8 {
		errorJSON(w, http.StatusBadRequest, "Name, email, and a password of at least 8 characters are required")
		return
	}
	if len(req.Photo) > 400_000 {
		errorJSON(w, http.StatusBadRequest, "That photo is too large — try a smaller one")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "Could not create account")
		return
	}

	user := User{
		ID:           uuid.NewString(),
		Name:         req.Name,
		Email:        req.Email,
		PasswordHash: string(hash),
		Photo:        req.Photo,
		CreatedAt:    time.Now(),
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	_, err = a.DB.Exec(ctx,
		`INSERT INTO users (id, name, email, password_hash, photo, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
		user.ID, user.Name, user.Email, user.PasswordHash, user.Photo, user.CreatedAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			errorJSON(w, http.StatusConflict, "An account with that email already exists")
			return
		}
		errorJSON(w, http.StatusInternalServerError, "Could not create account")
		return
	}

	token, err := a.makeToken(user.ID)
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "Could not create session")
		return
	}

	writeJSON(w, http.StatusCreated, authResponse{Token: token, User: user.Public()})
}

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := readJSON(r, &req); err != nil {
		errorJSON(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var user User
	err := a.DB.QueryRow(ctx,
		`SELECT id, name, email, password_hash, COALESCE(photo, '') FROM users WHERE email = $1`,
		req.Email,
	).Scan(&user.ID, &user.Name, &user.Email, &user.PasswordHash, &user.Photo)
	if err != nil {
		errorJSON(w, http.StatusUnauthorized, "Incorrect email or password")
		return
	}

	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)) != nil {
		errorJSON(w, http.StatusUnauthorized, "Incorrect email or password")
		return
	}

	token, err := a.makeToken(user.ID)
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "Could not create session")
		return
	}

	writeJSON(w, http.StatusOK, authResponse{Token: token, User: user.Public()})
}

func (a *App) handleMe(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFromContext(r.Context())
	if !ok {
		errorJSON(w, http.StatusUnauthorized, "Not authenticated")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var user User
	err := a.DB.QueryRow(ctx,
		`SELECT id, name, COALESCE(photo, '') FROM users WHERE id = $1`,
		userID,
	).Scan(&user.ID, &user.Name, &user.Photo)
	if err != nil {
		errorJSON(w, http.StatusNotFound, "User not found")
		return
	}

	writeJSON(w, http.StatusOK, user.Public())
}

func (a *App) makeToken(userID string) (string, error) {
	claims := jwt.MapClaims{
		"sub": userID,
		"exp": time.Now().Add(30 * 24 * time.Hour).Unix(),
		"iat": time.Now().Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(a.JWTSecret)
}
