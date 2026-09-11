package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Origin is enforced by the JWT + room-membership check below, not by the
	// browser's Origin header, so any origin can attempt the handshake.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Hub holds one in-memory room per active beacon code. This is intentionally
// not backed by the database — it only needs to live as long as people are
// actively connected, and a single Render instance is enough for a
// two-person-per-room app.
type Hub struct {
	mu    sync.Mutex
	rooms map[string]*wsRoom
}

type wsRoom struct {
	mu      sync.Mutex
	clients map[string]*wsClient // userID -> client
}

type wsClient struct {
	conn *websocket.Conn
	send chan []byte
	lat  *float64
	lng  *float64
}

func newHub() *Hub {
	return &Hub{rooms: make(map[string]*wsRoom)}
}

func (h *Hub) roomFor(code string) *wsRoom {
	h.mu.Lock()
	defer h.mu.Unlock()
	rm, ok := h.rooms[code]
	if !ok {
		rm = &wsRoom{clients: make(map[string]*wsClient)}
		h.rooms[code] = rm
	}
	return rm
}

type peerState struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Photo  string   `json:"photo,omitempty"`
	Lat    *float64 `json:"lat"`
	Lng    *float64 `json:"lng"`
	Online bool     `json:"online"`
}

type stateMessage struct {
	Type  string      `json:"type"`
	You   string      `json:"you"`
	Peers []peerState `json:"peers"`
}

type incomingMessage struct {
	Type string  `json:"type"`
	Lat  float64 `json:"lat"`
	Lng  float64 `json:"lng"`
}

// handleWS authenticates via a token QUERY PARAM rather than the usual
// Authorization header, because browsers cannot set custom headers on a
// WebSocket handshake. That's why this route sits outside authMiddleware and
// checks the token itself.
func (a *App) handleWS(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(chi.URLParam(r, "code"))
	token := r.URL.Query().Get("token")

	userID, err := a.parseToken(token)
	if err != nil {
		http.Error(w, "invalid or missing token", http.StatusUnauthorized)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	var roomID string
	err = a.DB.QueryRow(ctx, `SELECT id FROM rooms WHERE code = $1`, code).Scan(&roomID)
	cancel()
	if err != nil {
		http.Error(w, "beacon not found", http.StatusNotFound)
		return
	}

	ctx, cancel = context.WithTimeout(r.Context(), 5*time.Second)
	var isMember bool
	err = a.DB.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)`,
		roomID, userID,
	).Scan(&isMember)
	cancel()
	if err != nil || !isMember {
		http.Error(w, "not a member of this beacon", http.StatusForbidden)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	c := &wsClient{conn: conn, send: make(chan []byte, 8)}
	rm := a.Hub.roomFor(code)

	rm.mu.Lock()
	rm.clients[userID] = c
	rm.mu.Unlock()

	go c.writePump()
	a.broadcastState(code)

	defer func() {
		rm.mu.Lock()
		if rm.clients[userID] == c {
			delete(rm.clients, userID)
		}
		rm.mu.Unlock()
		close(c.send)
		conn.Close()
		a.broadcastState(code)
	}()

	conn.SetReadLimit(2048)
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var msg incomingMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		if msg.Type == "location" {
			rm.mu.Lock()
			if cl, ok := rm.clients[userID]; ok {
				lat, lng := msg.Lat, msg.Lng
				cl.lat, cl.lng = &lat, &lng
			}
			rm.mu.Unlock()
			a.broadcastState(code)
		}
	}
}

func (c *wsClient) writePump() {
	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

// broadcastState merges the durable member list (names, photos) from Postgres
// with each member's live in-memory position, then pushes the combined
// snapshot to every open socket in the room — including someone who is the
// only person there yet, so "who's currently here" is always accurate.
func (a *App) broadcastState(code string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	members, err := a.roomMembers(ctx, code)
	cancel()
	if err != nil {
		log.Printf("broadcastState: fetch members for %s: %v", code, err)
		return
	}

	rm := a.Hub.roomFor(code)
	rm.mu.Lock()
	defer rm.mu.Unlock()

	peers := make([]peerState, 0, len(members))
	for _, m := range members {
		p := peerState{ID: m.ID, Name: m.Name, Photo: m.Photo}
		if cl, ok := rm.clients[m.ID]; ok {
			p.Online = true
			p.Lat, p.Lng = cl.lat, cl.lng
		}
		peers = append(peers, p)
	}

	for userID, cl := range rm.clients {
		payload, err := json.Marshal(stateMessage{Type: "state", You: userID, Peers: peers})
		if err != nil {
			continue
		}
		select {
		case cl.send <- payload:
		default:
			// slow consumer; drop rather than block the whole room
		}
	}
}
