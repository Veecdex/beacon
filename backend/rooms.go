package main

import (
	"context"
	"math/rand"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Avoids visually ambiguous characters (0/O, 1/I) so codes are easy to read
// aloud or type on a phone.
const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func randomCode() string {
	b := make([]byte, 5)
	for i := range b {
		b[i] = codeChars[rand.Intn(len(codeChars))]
	}
	return string(b)
}

type roomResponse struct {
	Code    string       `json:"code"`
	Members []PublicUser `json:"members"`
}

func (a *App) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	userID, _ := userIDFromContext(r.Context())

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	code := randomCode()
	for attempt := 0; attempt < 5; attempt++ {
		var exists bool
		if err := a.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM rooms WHERE code = $1)`, code).Scan(&exists); err != nil {
			errorJSON(w, http.StatusInternalServerError, "Could not create beacon")
			return
		}
		if !exists {
			break
		}
		code = randomCode()
	}

	roomID := uuid.NewString()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "Could not create beacon")
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `INSERT INTO rooms (id, code, created_by) VALUES ($1,$2,$3)`, roomID, code, userID); err != nil {
		errorJSON(w, http.StatusInternalServerError, "Could not create beacon")
		return
	}
	if _, err := tx.Exec(ctx, `INSERT INTO room_members (room_id, user_id) VALUES ($1,$2)`, roomID, userID); err != nil {
		errorJSON(w, http.StatusInternalServerError, "Could not create beacon")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		errorJSON(w, http.StatusInternalServerError, "Could not create beacon")
		return
	}

	members, _ := a.roomMembers(ctx, code)
	writeJSON(w, http.StatusCreated, roomResponse{Code: code, Members: members})
}

type joinRoomRequest struct {
	Code string `json:"code"`
}

func (a *App) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	userID, _ := userIDFromContext(r.Context())

	var req joinRoomRequest
	if err := readJSON(r, &req); err != nil {
		errorJSON(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	code := strings.ToUpper(strings.TrimSpace(req.Code))
	if code == "" {
		errorJSON(w, http.StatusBadRequest, "Enter a beacon code")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var roomID string
	if err := a.DB.QueryRow(ctx, `SELECT id FROM rooms WHERE code = $1`, code).Scan(&roomID); err != nil {
		errorJSON(w, http.StatusNotFound, "No beacon found with that code")
		return
	}

	var alreadyMember bool
	if err := a.DB.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)`,
		roomID, userID,
	).Scan(&alreadyMember); err != nil {
		errorJSON(w, http.StatusInternalServerError, "Could not join beacon")
		return
	}

	if !alreadyMember {
		var count int
		if err := a.DB.QueryRow(ctx, `SELECT COUNT(*) FROM room_members WHERE room_id=$1`, roomID).Scan(&count); err != nil {
			errorJSON(w, http.StatusInternalServerError, "Could not join beacon")
			return
		}
		if count >= 2 {
			errorJSON(w, http.StatusForbidden, "This beacon already has two people. Ask them for a new code, or start your own.")
			return
		}
		if _, err := a.DB.Exec(ctx, `INSERT INTO room_members (room_id, user_id) VALUES ($1,$2)`, roomID, userID); err != nil {
			errorJSON(w, http.StatusInternalServerError, "Could not join beacon")
			return
		}
	}

	members, _ := a.roomMembers(ctx, code)
	writeJSON(w, http.StatusOK, roomResponse{Code: code, Members: members})
}

func (a *App) handleGetRoom(w http.ResponseWriter, r *http.Request) {
	userID, _ := userIDFromContext(r.Context())
	code := strings.ToUpper(chi.URLParam(r, "code"))

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var roomID string
	if err := a.DB.QueryRow(ctx, `SELECT id FROM rooms WHERE code = $1`, code).Scan(&roomID); err != nil {
		errorJSON(w, http.StatusNotFound, "No beacon found with that code")
		return
	}

	var isMember bool
	if err := a.DB.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)`,
		roomID, userID,
	).Scan(&isMember); err != nil || !isMember {
		errorJSON(w, http.StatusForbidden, "You're not part of this beacon")
		return
	}

	members, _ := a.roomMembers(ctx, code)
	writeJSON(w, http.StatusOK, roomResponse{Code: code, Members: members})
}

func (a *App) roomMembers(ctx context.Context, code string) ([]PublicUser, error) {
	rows, err := a.DB.Query(ctx, `
		SELECT u.id, u.name, COALESCE(u.photo, '')
		FROM room_members rm
		JOIN rooms r ON r.id = rm.room_id
		JOIN users u ON u.id = rm.user_id
		WHERE r.code = $1
		ORDER BY rm.joined_at ASC
	`, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	members := []PublicUser{}
	for rows.Next() {
		var u PublicUser
		if err := rows.Scan(&u.ID, &u.Name, &u.Photo); err != nil {
			return nil, err
		}
		members = append(members, u)
	}
	return members, nil
}
