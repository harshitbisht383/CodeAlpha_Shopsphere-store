import json
import os
import re
import secrets
import sqlite3
from datetime import timedelta
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash


BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = Path(os.environ.get("SHOPSPHERE_DATABASE", BASE_DIR / "shopsphere.db"))


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exception_type, exception_value, traceback):
        try:
            return super().__exit__(exception_type, exception_value, traceback)
        finally:
            self.close()


app = Flask(__name__, static_folder=None)
app.config.update(
    SECRET_KEY=os.environ.get("SHOPSPHERE_SECRET_KEY") or secrets.token_hex(32),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("SHOPSPHERE_HTTPS", "").lower() == "true",
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    MAX_CONTENT_LENGTH=16 * 1024,
)


def connect_database():
    database = sqlite3.connect(
        DATABASE_PATH,
        timeout=10,
        factory=ClosingConnection,
    )
    database.row_factory = sqlite3.Row
    database.execute("PRAGMA foreign_keys = ON")
    return database


def init_database():
    products = json.loads((BASE_DIR / "products.json").read_text(encoding="utf-8"))
    for product in products:
        product.setdefault("oldPrice", None)
        product.setdefault("badge", None)
    with connect_database() as database:
        database.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                email TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                price INTEGER NOT NULL CHECK(price >= 0),
                old_price INTEGER,
                icon TEXT NOT NULL,
                rating REAL NOT NULL,
                description TEXT NOT NULL,
                badge TEXT
            );
            CREATE TABLE IF NOT EXISTS cart_items (
                owner TEXT NOT NULL,
                product_id TEXT NOT NULL REFERENCES products(id),
                quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),
                PRIMARY KEY (owner, product_id)
            );
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                customer_name TEXT NOT NULL,
                customer_email TEXT NOT NULL,
                address TEXT NOT NULL,
                latitude REAL,
                longitude REAL,
                location_accuracy REAL,
                total INTEGER NOT NULL CHECK(total >= 0),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY,
                order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                product_id TEXT NOT NULL,
                product_name TEXT NOT NULL,
                unit_price INTEGER NOT NULL,
                quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99)
            );
            """
        )
        database.executemany(
            """
            INSERT INTO products (id, name, category, price, old_price, icon, rating, description, badge)
            VALUES (:id, :name, :category, :price, :oldPrice, :icon, :rating, :description, :badge)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                category = excluded.category,
                price = excluded.price,
                old_price = excluded.old_price,
                icon = excluded.icon,
                rating = excluded.rating,
                description = excluded.description,
                badge = excluded.badge
            """,
            products,
        )


def get_database():
    if "database" not in g:
        g.database = connect_database()
    return g.database


@app.teardown_appcontext
def close_database(_error=None):
    database = g.pop("database", None)
    if database is not None:
        database.close()


def json_body():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return None, (jsonify(error="Request body must be JSON."), 400)
    return body, None


def require_csrf():
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token", "")
    if not expected or not secrets.compare_digest(expected, supplied):
        return jsonify(error="Your session expired. Refresh the page and try again."), 400
    return None


def current_user():
    user_id = session.get("user_id")
    if user_id is None:
        return None
    return get_database().execute(
        "SELECT id, username, email FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()


def cart_owner():
    user = current_user()
    if user:
        return "user:" + str(user["id"])
    guest_id = session.get("guest_id")
    if guest_id is None:
        guest_id = secrets.token_urlsafe(24)
        session["guest_id"] = guest_id
    return "guest:" + guest_id


def cart_payload(owner=None):
    owner = owner or cart_owner()
    rows = get_database().execute(
        """
        SELECT p.id, p.name, p.category, p.price, p.icon, ci.quantity
        FROM cart_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.owner = ?
        ORDER BY p.name COLLATE NOCASE
        """,
        (owner,),
    ).fetchall()
    items = [
        {
            "id": row["id"],
            "name": row["name"],
            "category": row["category"],
            "price": row["price"],
            "icon": row["icon"],
            "quantity": row["quantity"],
            "subtotal": row["price"] * row["quantity"],
        }
        for row in rows
    ]
    return {
        "items": items,
        "count": sum(item["quantity"] for item in items),
        "total": sum(item["subtotal"] for item in items),
    }


def merge_guest_cart(user_id):
    guest_id = session.pop("guest_id", None)
    if not guest_id:
        return
    database = get_database()
    guest_owner = "guest:" + guest_id
    user_owner = "user:" + str(user_id)
    rows = database.execute(
        "SELECT product_id, quantity FROM cart_items WHERE owner = ?",
        (guest_owner,),
    ).fetchall()
    for row in rows:
        database.execute(
            """
            INSERT INTO cart_items (owner, product_id, quantity) VALUES (?, ?, ?)
            ON CONFLICT(owner, product_id) DO UPDATE SET
                quantity = MIN(99, cart_items.quantity + excluded.quantity)
            """,
            (user_owner, row["product_id"], row["quantity"]),
        )
    database.execute("DELETE FROM cart_items WHERE owner = ?", (guest_owner,))
    database.commit()


@app.after_request
def secure_api_responses(response):
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
    return response


@app.get("/")
@app.get("/index.html")
def home():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    if filename not in {"style.css", "script.js"}:
        return jsonify(error="Not found."), 404
    return send_from_directory(BASE_DIR, filename)


@app.get("/api/health")
def health():
    return jsonify(status="ok")


@app.get("/api/bootstrap")
def bootstrap():
    session.permanent = True
    csrf_token = session.setdefault("csrf_token", secrets.token_urlsafe(32))
    products = get_database().execute(
        """
        SELECT id, name, category, price, old_price AS oldPrice, icon, rating, description, badge
        FROM products ORDER BY name COLLATE NOCASE
        """
    ).fetchall()
    user = current_user()
    return jsonify(
        csrfToken=csrf_token,
        user=dict(user) if user else None,
        products=[dict(product) for product in products],
        cart=cart_payload(),
    )


@app.post("/api/register")
def register():
    csrf_error = require_csrf()
    if csrf_error:
        return csrf_error
    body, error = json_body()
    if error:
        return error
    username = str(body.get("username", "")).strip()
    email = str(body.get("email", "")).strip().lower()
    password = body.get("password", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", username):
        return jsonify(error="Username must be 3–32 characters and use letters, numbers, dot, dash or underscore."), 400
    if len(email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify(error="Enter a valid email address."), 400
    if not isinstance(password, str) or len(password) < 8 or len(password) > 256:
        return jsonify(error="Password must be between 8 and 256 characters."), 400
    database = get_database()
    guest_id = session.get("guest_id")
    try:
        cursor = database.execute(
            "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
            (username, email, generate_password_hash(password)),
        )
        database.commit()
    except sqlite3.IntegrityError:
        return jsonify(error="That username or email is already registered."), 409
    session.clear()
    session.permanent = True
    session["user_id"] = cursor.lastrowid
    session["csrf_token"] = secrets.token_urlsafe(32)
    if guest_id:
        session["guest_id"] = guest_id
    merge_guest_cart(cursor.lastrowid)
    user = current_user()
    return jsonify(
        user=dict(user),
        csrfToken=session["csrf_token"],
        cart=cart_payload(),
    ), 201


@app.post("/api/login")
def login():
    csrf_error = require_csrf()
    if csrf_error:
        return csrf_error
    body, error = json_body()
    if error:
        return error
    identity = str(body.get("identity", "")).strip()
    password = body.get("password", "")
    user = get_database().execute(
        "SELECT id, username, email, password_hash FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE",
        (identity, identity),
    ).fetchone()
    if not user or not isinstance(password, str) or not check_password_hash(user["password_hash"], password):
        return jsonify(error="Username/email or password is incorrect."), 401
    user_id = user["id"]
    guest_id = session.get("guest_id")
    session.clear()
    session.permanent = True
    session["user_id"] = user_id
    session["csrf_token"] = secrets.token_urlsafe(32)
    if guest_id:
        session["guest_id"] = guest_id
    merge_guest_cart(user_id)
    authenticated_user = current_user()
    return jsonify(
        user=dict(authenticated_user),
        csrfToken=session["csrf_token"],
        cart=cart_payload(),
    )


@app.post("/api/logout")
def logout():
    csrf_error = require_csrf()
    if csrf_error:
        return csrf_error
    session.clear()
    session.permanent = True
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify(csrfToken=session["csrf_token"], cart=cart_payload())


@app.get("/api/cart")
def get_cart():
    return jsonify(cart_payload())


@app.post("/api/cart")
def add_cart_item():
    csrf_error = require_csrf()
    if csrf_error:
        return csrf_error
    body, error = json_body()
    if error:
        return error
    product_id = str(body.get("productId", ""))
    quantity = body.get("quantity", 1)
    if type(quantity) is not int or not 1 <= quantity <= 99:
        return jsonify(error="Quantity must be between 1 and 99."), 400
    database = get_database()
    if not database.execute("SELECT 1 FROM products WHERE id = ?", (product_id,)).fetchone():
        return jsonify(error="Product not found."), 404
    database.execute(
        """
        INSERT INTO cart_items (owner, product_id, quantity) VALUES (?, ?, ?)
        ON CONFLICT(owner, product_id) DO UPDATE SET
            quantity = MIN(99, cart_items.quantity + excluded.quantity)
        """,
        (cart_owner(), product_id, quantity),
    )
    database.commit()
    return jsonify(cart=cart_payload())


@app.put("/api/cart/<product_id>")
def update_cart_item(product_id):
    csrf_error = require_csrf()
    if csrf_error:
        return csrf_error
    body, error = json_body()
    if error:
        return error
    quantity = body.get("quantity")
    if type(quantity) is not int or not 1 <= quantity <= 99:
        return jsonify(error="Quantity must be between 1 and 99."), 400
    cursor = get_database().execute(
        "UPDATE cart_items SET quantity = ? WHERE owner = ? AND product_id = ?",
        (quantity, cart_owner(), product_id),
    )
    get_database().commit()
    if cursor.rowcount == 0:
        return jsonify(error="Cart item not found."), 404
    return jsonify(cart=cart_payload())


@app.delete("/api/cart/<product_id>")
def remove_cart_item(product_id):
    csrf_error = require_csrf()
    if csrf_error:
        return csrf_error
    get_database().execute(
        "DELETE FROM cart_items WHERE owner = ? AND product_id = ?",
        (cart_owner(), product_id),
    )
    get_database().commit()
    return jsonify(cart=cart_payload())


@app.delete("/api/cart")
def clear_cart():
    csrf_error = require_csrf()
    if csrf_error:
        return csrf_error
    get_database().execute("DELETE FROM cart_items WHERE owner = ?", (cart_owner(),))
    get_database().commit()
    return jsonify(cart=cart_payload())


@app.post("/api/checkout")
def checkout():
    csrf_error = require_csrf()
    if csrf_error:
        return csrf_error
    user = current_user()
    if not user:
        return jsonify(error="Please sign in before placing an order."), 401
    body, error = json_body()
    if error:
        return error
    name = str(body.get("name", "")).strip()
    email = str(body.get("email", "")).strip().lower()
    address = str(body.get("address", "")).strip()
    if not name or len(name) > 120:
        return jsonify(error="Enter your name (up to 120 characters)."), 400
    if len(email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify(error="Enter a valid email address."), 400
    if not address or len(address) > 2000:
        return jsonify(error="Enter a delivery address (up to 2,000 characters)."), 400

    latitude = body.get("latitude")
    longitude = body.get("longitude")
    accuracy = body.get("accuracy")
    location_values = (latitude, longitude, accuracy)
    if any(value is not None for value in location_values):
        if (
            type(latitude) not in (int, float)
            or type(longitude) not in (int, float)
            or type(accuracy) not in (int, float)
            or not -90 <= latitude <= 90
            or not -180 <= longitude <= 180
            or not 0 <= accuracy <= 100000
        ):
            return jsonify(error="Location coordinates are invalid."), 400

    database = get_database()
    owner = cart_owner()
    items = database.execute(
        """
        SELECT p.id, p.name, p.price, ci.quantity
        FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.owner = ?
        """,
        (owner,),
    ).fetchall()
    if not items:
        return jsonify(error="Your cart is empty."), 400

    total = sum(item["price"] * item["quantity"] for item in items)
    try:
        cursor = database.execute(
            """
            INSERT INTO orders
                (user_id, customer_name, customer_email, address, latitude, longitude, location_accuracy, total)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user["id"] if user else None,
                name,
                email,
                address,
                latitude,
                longitude,
                accuracy,
                total,
            ),
        )
        order_id = cursor.lastrowid
        database.executemany(
            """
            INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (order_id, item["id"], item["name"], item["price"], item["quantity"])
                for item in items
            ],
        )
        database.execute("DELETE FROM cart_items WHERE owner = ?", (owner,))
        database.commit()
    except sqlite3.Error:
        database.rollback()
        app.logger.exception("Could not save checkout order")
        return jsonify(error="Could not save your order. Please try again."), 500
    return jsonify(orderId=order_id, total=total, cart=cart_payload(owner)), 201


@app.get("/api/orders")
def list_orders():
    user = current_user()
    if not user:
        return jsonify(error="Sign in to view saved orders."), 401
    rows = get_database().execute(
        """
        SELECT id, customer_name, customer_email, address, total, created_at
        FROM orders WHERE user_id = ? ORDER BY id DESC
        """,
        (user["id"],),
    ).fetchall()
    return jsonify(orders=[dict(row) for row in rows])


@app.cli.command("init-db")
def init_db_command():
    init_database()
    print("ShopSphere database initialized.")


init_database()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), debug=False)
