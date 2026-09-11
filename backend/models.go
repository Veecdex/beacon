package main

import "time"

// User is the full database record, including the password hash. It's never
// serialized to JSON directly — handlers always convert to PublicUser first.
type User struct {
	ID           string
	Name         string
	Email        string
	PasswordHash string
	Photo        string
	CreatedAt    time.Time
}

// PublicUser is what other people (and the person themselves) are allowed to
// see: no email, no password hash.
type PublicUser struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Photo string `json:"photo,omitempty"`
}

func (u User) Public() PublicUser {
	return PublicUser{ID: u.ID, Name: u.Name, Photo: u.Photo}
}
