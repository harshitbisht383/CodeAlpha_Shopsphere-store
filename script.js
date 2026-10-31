
"use strict";

/* ==========================================
   1. COMMON HELPER FUNCTIONS
========================================== */

function getElement(id) {
    return document.getElementById(id);
}

async function loadStore() {
    const bootstrap = await apiRequest("/api/bootstrap");
    renderAdditionalProducts(bootstrap.products);
    serverCart = bootstrap.cart;
    renderDemoCart();
    filterProducts();
}

function formatPrice(price) {
    return Number(price).toLocaleString("en-IN", {
        maximumFractionDigits: 2
    });
}

let csrfToken = "";
let serverCart = { items: [], count: 0, total: 0 };
let currentUser = null;
let currentGpsPosition = null;
let pendingBuyProductId = null;
let pendingCheckout = false;

async function apiRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");

    if (options.body !== undefined) {
        headers.set("Content-Type", "application/json");
    }
    if (csrfToken && options.method && options.method !== "GET") {
        headers.set("X-CSRF-Token", csrfToken);
    }

    let response;
    try {
        response = await fetch(path, {
            ...options,
            headers,
            credentials: "same-origin"
        });
    } catch (error) {
        throw new Error("Could not reach the ShopSphere backend. Start it with python app.py.");
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        throw new Error("The ShopSphere API is not responding. Start the Flask backend with python app.py and open http://127.0.0.1:8000/.");
    }

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 400 && result.error?.includes("session expired")) {
            window.location.reload();
        }
        const apiError = new Error(result.error || "The request failed. Please try again.");
        apiError.retryAfter = result.retryAfter;
        throw apiError;
    }

    if (result.csrfToken) {
        csrfToken = result.csrfToken;
    }
    if (result.user !== undefined) {
        currentUser = result.user;
        document.body.classList.toggle("auth-locked", !currentUser);
        updateAccountNavigation();
    }
    if (result.cart) {
        serverCart = result.cart;
        renderDemoCart();
    }
    return result;
}

function updateAccountNavigation() {
    const loginButton = getElement("loginAction");
    const registerButton = getElement("registerAction");
    const sellerButton = getElement("sellerAction");
    const navActions = document.querySelector(".nav-actions");
    let logoutButton = getElement("logoutAction");

    if (loginButton) {
        loginButton.hidden = Boolean(currentUser);
    }
    if (registerButton) {
        registerButton.hidden = Boolean(currentUser);
    }
    if (sellerButton) {
        sellerButton.hidden = !currentUser;
    }

    if (currentUser && navActions && !logoutButton) {
        logoutButton = document.createElement("button");
        logoutButton.type = "button";
        logoutButton.id = "logoutAction";
        logoutButton.innerHTML = "<small>Signed in as</small><strong></strong>";
        logoutButton.querySelector("strong").textContent = currentUser.email;
        logoutButton.addEventListener("click", async function () {
            try {
                const result = await apiRequest("/api/logout", { method: "POST", body: "{}" });
                currentUser = null;
                document.body.classList.add("auth-locked");
                csrfToken = result.csrfToken;
                serverCart = result.cart;
                logoutButton.remove();
                updateAccountNavigation();
                renderDemoCart();
                showSection("login");
                showMessage(getElement("cartFeedback"), "You have signed out.", "info");
                getElement("cartFeedback").hidden = false;
            } catch (error) {
                showMessage(getElement("cartFeedback"), error.message, "error");
                getElement("cartFeedback").hidden = false;
            }
        });
        navActions.insertBefore(logoutButton, getElement("cartCount").closest("button"));
    } else if (currentUser && logoutButton) {
        logoutButton.querySelector("strong").textContent = currentUser.email;
    } else if (!currentUser && logoutButton) {
        logoutButton.remove();
    }
}

function showMessage(element, message, type = "info") {
    if (!element) return;

    element.textContent = message;
    element.className = "message " + type;
}

/* ==========================================
   2. PRODUCT SEARCH, CATEGORY FILTER
   AND PRICE SORTING
========================================== */

function filterProducts() {
    const searchInput = getElement("searchInput");
    const categoryFilter = getElement("categoryFilter");
    const sortFilter = getElement("sortFilter");
    const productGrid = getElement("productGrid");
    const noProductsMessage = getElement("noProductsMessage");

    if (!productGrid) return;

    const searchTerm = searchInput
        ? searchInput.value.trim().toLowerCase()
        : "";

    const selectedCategory = categoryFilter
        ? categoryFilter.value.toLowerCase()
        : "all";

    const sortOrder = sortFilter
        ? sortFilter.value
        : "default";

    const products = Array.from(
        productGrid.querySelectorAll(".product-card")
    );

    let visibleCount = 0;

    products.forEach(product => {
        const searchableText = [
            product.dataset.name ||
            product.querySelector("h3")?.textContent ||
            "",
            product.dataset.category || "",
            product.dataset.description || ""
        ].join(" ").toLowerCase();

        const category = (product.dataset.category || "").toLowerCase();

        const matchesSearch = searchableText.includes(searchTerm);

        const matchesCategory =
            selectedCategory === "all" ||
            category === selectedCategory;

        const visible = matchesSearch && matchesCategory;

        product.hidden = !visible;

        if (visible) {
            visibleCount++;
        }
    });

    if (sortOrder === "low" || sortOrder === "high") {
        const visibleProducts = products.filter(
            product => !product.hidden
        );

        visibleProducts.sort((a, b) => {
            const priceA = Number(a.dataset.price || 0);
            const priceB = Number(b.dataset.price || 0);

            return sortOrder === "low"
                ? priceA - priceB
                : priceB - priceA;
        });

        visibleProducts.forEach(product => {
            productGrid.appendChild(product);
        });
    }

    if (noProductsMessage) {
        noProductsMessage.hidden = visibleCount !== 0;
    }

    const productCount = getElement("productCount");
    if (productCount) {
        productCount.textContent =
            visibleCount + (visibleCount === 1 ? " product" : " products") +
            " · Great finds, everyday value";
    }
}


/* ==========================================
   3. SERVER-BACKED CART
========================================== */

function renderAdditionalProducts(products) {
    const productGrid = getElement("productGrid");
    if (!productGrid) return;

    productGrid.replaceChildren();
    products.forEach(product => {
        const card = document.createElement("article");
        card.className = "product-card";
        card.dataset.name = product.name.toLowerCase();
        card.dataset.category = product.category;
        card.dataset.description = product.description.toLowerCase();
        card.dataset.price = product.price;
        card.dataset.productId = product.id;

        if (product.badge) {
            const badge = document.createElement("span");
            badge.className = "product-badge" +
                (product.badge === "GREAT VALUE" ? " badge-deal" : "");
            badge.textContent = product.badge;
            card.appendChild(badge);
        }

        const image = product.imageUrl
            ? document.createElement("img")
            : document.createElement("div");
        image.className = "product-image product-image-" +
            (product.id === "wireless-headphones" ? "audio" :
                product.id === "everyday-backpack" ? "bag" :
                    product.id === "classic-cotton-tee" ? "shirt" :
                        product.id === "everyday-sneakers" ? "shoes" :
                            product.id === "desk-plant-pot" ? "home" : product.category);
        if (product.imageUrl) {
            image.src = product.imageUrl;
            image.alt = product.name;
            image.addEventListener("error", function () {
                const fallback = document.createElement("div");
                fallback.className = image.className;
                fallback.setAttribute("role", "img");
                fallback.setAttribute("aria-label", product.name);
                fallback.textContent = product.icon;
                image.replaceWith(fallback);
            }, { once: true });
        } else {
            image.setAttribute("role", "img");
            image.setAttribute("aria-label", product.name);
            image.textContent = product.icon;
        }

        const category = document.createElement("p");
        category.className = "product-category";
        category.textContent = product.category === "home"
            ? "Home & Living"
            : product.category.charAt(0).toUpperCase() + product.category.slice(1);

        const title = document.createElement("h3");
        title.textContent = product.name;

        const description = document.createElement("p");
        description.textContent = product.description;

        const rating = document.createElement("p");
        rating.className = "rating";
        rating.setAttribute("aria-label", "Rated 4.5 out of 5");
        rating.append(document.createTextNode("★★★★★ "));
        const ratingValue = document.createElement("span");
        ratingValue.textContent = Number(product.rating).toFixed(1);
        rating.appendChild(ratingValue);
        rating.setAttribute("aria-label", "Rated " + ratingValue.textContent + " out of 5");

        const price = document.createElement("p");
        price.className = "price";
        const currentPrice = document.createElement("strong");
        currentPrice.textContent = "₹" + formatPrice(product.price);
        price.appendChild(currentPrice);
        if (product.oldPrice) {
            const oldPrice = document.createElement("del");
            oldPrice.textContent = "₹" + formatPrice(product.oldPrice);
            price.appendChild(oldPrice);
        }

        const actions = document.createElement("div");
        actions.className = "product-actions";

        const stockNote = document.createElement("p");
        stockNote.className = "product-stock";
        stockNote.textContent = product.stock > 0
            ? product.stock + " available"
            : "Out of stock";

        const addButton = document.createElement("button");
        addButton.type = "button";
        addButton.className = "btn";
        addButton.textContent = "Add to cart";
        addButton.disabled = product.stock < 1;
        addButton.addEventListener("click", function () {
            addToCart(product.id);
        });

        const buyButton = document.createElement("button");
        buyButton.type = "button";
        buyButton.className = "btn buy-now";
        buyButton.textContent = "Buy now";
        buyButton.disabled = product.stock < 1;
        buyButton.addEventListener("click", function () {
            buyNow(product.id);
        });

        actions.append(addButton, buyButton);
        card.append(image, category, title, description, rating, price, stockNote, actions);
        productGrid.appendChild(card);
    });
}

function updateDemoCartCount(cart) {
    const countElement = getElement("cartCount");

    if (!countElement) return;
    countElement.textContent = cart.count;
}

function renderDemoCart(cart = serverCart) {
    const cartItemsElement = getElement("cartItems");
    const cartTotalElement = getElement("cartTotal");
    const checkoutTotalElement = getElement("checkoutTotal");

    updateDemoCartCount(cart);

    if (cartTotalElement) {
        cartTotalElement.textContent = formatPrice(cart.total);
    }

    if (checkoutTotalElement) {
        checkoutTotalElement.textContent = formatPrice(cart.total);
    }

    if (!cartItemsElement) return;

    cartItemsElement.replaceChildren();

    if (cart.items.length === 0) {
        const emptyMessage = document.createElement("p");
        emptyMessage.textContent = "Your cart is empty.";
        cartItemsElement.appendChild(emptyMessage);
        return;
    }

    cart.items.forEach(item => {
        const row = document.createElement("div");
        row.className = "cart-item";

        const details = document.createElement("div");

        const title = document.createElement("h3");
        title.textContent = item.name;

        const price = document.createElement("p");
        price.textContent =
            "Price: ₹" + formatPrice(item.price);

        const quantity = document.createElement("p");
        quantity.textContent = "Quantity: " + item.quantity;

        const subtotal = document.createElement("p");
        subtotal.textContent =
            "Subtotal: ₹" +
            formatPrice(item.price * item.quantity);

        details.append(title, price, quantity, subtotal);

        const actions = document.createElement("div");

        const decreaseButton = document.createElement("button");
        decreaseButton.type = "button";
        decreaseButton.textContent = "−";
        decreaseButton.setAttribute(
            "aria-label",
            "Decrease quantity of " + item.name
        );

        decreaseButton.addEventListener("click", function () {
            changeDemoQuantity(item.id, item.quantity - 1);
        });

        const increaseButton = document.createElement("button");
        increaseButton.type = "button";
        increaseButton.textContent = "+";
        increaseButton.setAttribute(
            "aria-label",
            "Increase quantity of " + item.name
        );

        increaseButton.addEventListener("click", function () {
            changeDemoQuantity(item.id, item.quantity + 1);
        });

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.textContent = "Remove";

        removeButton.addEventListener("click", function () {
            removeFromDemoCart(item.id);
        });

        actions.append(
            decreaseButton,
            increaseButton,
            removeButton
        );

        row.append(details, actions);
        cartItemsElement.appendChild(row);
    });
}

async function addToCart(productId) {
    try {
        await apiRequest("/api/cart", {
            method: "POST",
            body: JSON.stringify({ productId })
        });
        const product = document.querySelector(
            '[data-product-id="' + CSS.escape(productId) + '"] h3'
        );
        const feedback = getElement("cartFeedback");
        showMessage(feedback, (product?.textContent || "Product") + " added to your cart.", "success");
        feedback.hidden = false;
        return true;
    } catch (error) {
        const feedback = getElement("cartFeedback");
        showMessage(feedback, error.message, "error");
        feedback.hidden = false;
        return false;
    }
}

async function buyNow(productId) {
    requestCurrentLocation();
    if (!currentUser) {
        pendingBuyProductId = productId;
        pendingCheckout = false;
        showSection("login");
        showMessage(
            getElement("loginMessage"),
            "Please sign in or create an account before buying.",
            "info"
        );
        return;
    }

    if (await addToCart(productId)) {
        showSection("checkout");
    }
}

function continuePendingPurchase() {
    const productId = pendingBuyProductId;
    const shouldOpenCheckout = Boolean(productId) || pendingCheckout;
    pendingBuyProductId = null;
    pendingCheckout = false;

    if (productId) {
        addToCart(productId).then(added => {
            if (added) {
                showSection("checkout");
            }
        });
    } else if (shouldOpenCheckout) {
        showSection("checkout");
    }
}

async function changeDemoQuantity(productId, quantity) {
    try {
        if (quantity < 1) {
            await apiRequest("/api/cart/" + encodeURIComponent(productId), {
                method: "DELETE"
            });
        } else {
            await apiRequest("/api/cart/" + encodeURIComponent(productId), {
                method: "PUT",
                body: JSON.stringify({ quantity })
            });
        }
    } catch (error) {
        showCartError(error);
    }
}

async function removeFromDemoCart(productId) {
    try {
        await apiRequest("/api/cart/" + encodeURIComponent(productId), {
            method: "DELETE"
        });
    } catch (error) {
        showCartError(error);
    }
}

async function clearCart() {
    const confirmed = confirm(
        "Are you sure you want to clear your cart?"
    );

    if (!confirmed) return;

    try {
        await apiRequest("/api/cart", { method: "DELETE" });
    } catch (error) {
        showCartError(error);
    }
}

function showCartError(error) {
    const feedback = getElement("cartFeedback");
    showMessage(feedback, error.message, "error");
    feedback.hidden = false;
}


/* ==========================================
   4. PAGE NAVIGATION
========================================== */

function showSection(sectionId) {
    const sectionIds = [
        "cart",
        "checkout",
        "seller",
        "login",
        "register"
    ];

    if (!currentUser && sectionId !== "login" && sectionId !== "register") {
        showSection("login");
        showMessage(
            getElement("loginMessage"),
            "Please sign in or create an account to continue.",
            "info"
        );
        return;
    }
    document.body.classList.toggle(
        "auth-register",
        !currentUser && sectionId === "register"
    );

    sectionIds.forEach(id => {
        const section = getElement(id);

        if (section) {
            section.style.display =
                id === sectionId ? "block" : "none";
        }
    });

    document.querySelectorAll(
        "#home > section:not(#cart):not(#checkout):not(#seller):not(#login):not(#register)"
    ).forEach(section => {
        section.hidden = sectionId !== "home";
    });

    if (sectionId === "cart" || sectionId === "checkout") {
        renderDemoCart();
    }
    if (sectionId === "seller") {
        loadSellerDashboard();
    }

    const target = sectionId === "home"
        ? getElement("home")
        : getElement(sectionId);

    if (target) {
        target.scrollIntoView({
            behavior: "smooth",
            block: "start"
        });
    }
}

function goToCheckout() {
    if (serverCart.items.length === 0) {
        alert("Your cart is empty. Add a product first.");
        return;
    }

    if (!currentUser) {
        pendingCheckout = true;
        showSection("login");
        showMessage(
            getElement("loginMessage"),
            "Please sign in before checkout. Your cart will be kept.",
            "info"
        );
        return;
    }

    requestCurrentLocation();
    showSection("checkout");
}

function requestCurrentLocation() {
    const status = getElement("locationStatus");
    const locationButton = getElement("useCurrentLocation");
    if (currentGpsPosition) {
        showMessage(status, "Delivery location is ready. Please enter your street address below.", "success");
        return;
    }

    if (!navigator.geolocation) {
        showMessage(
            status,
            "This browser does not support location access. Please type your delivery address.",
            "error"
        );
        return;
    }

    if (!window.isSecureContext) {
        showMessage(
            status,
            "Location access requires HTTPS or localhost. Open this project at http://127.0.0.1:8000, then allow location in your browser.",
            "error"
        );
        return;
    }

    if (location.protocol === "file:") {
        showMessage(
            status,
            "This page is opened as a file, so the browser is blocking real location access. Open http://127.0.0.1:8000 instead, then allow Location for this site.",
            "error"
        );
        return;
    }

    showMessage(status, "Please allow location access in your browser to add your delivery coordinates. You can also enter your address manually.", "info");
    if (locationButton) {
        locationButton.disabled = true;
        locationButton.textContent = "Requesting location...";
    }

    try {
        navigator.geolocation.getCurrentPosition(
        function (position) {
            const { latitude, longitude, accuracy } = position.coords;
            currentGpsPosition = { latitude, longitude, accuracy };
            showMessage(status, "Delivery location added (accuracy about " + Math.round(accuracy) + " m). Enter your house number, street and area in the address field.", "success");

            const deliveryText = document.querySelector(".delivery-link strong");
            if (deliveryText) {
                deliveryText.textContent = "Location ready";
            }
            if (locationButton) {
                locationButton.disabled = false;
                locationButton.textContent = "Update delivery location";
            }

        },
        function (error) {
            let message;

            switch (error.code) {
                case error.PERMISSION_DENIED:
                    message = "Browser denied location access. On http://127.0.0.1:8000, open the site controls beside the address bar, set Location to Allow, then try again. Also check that device Location services are on.";
                    break;
                case error.POSITION_UNAVAILABLE:
                    message = "Your location is currently unavailable. Please try again or type your address.";
                    break;
                case error.TIMEOUT:
                    message = "Location request timed out. Please try again or type your address.";
                    break;
                default:
                    message = "Could not get your location. Please type your address manually.";
            }

            showMessage(status, message, "error");

            if (locationButton) {
                locationButton.disabled = false;
                locationButton.textContent = "Allow location for delivery";
            }
        },
        {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        }
        );
    } catch (error) {
        showMessage(
            status,
            "Could not start location access: " +
            error.message +
            ". Open http://127.0.0.1:8000 and allow Location in your browser.",
            "error"
        );

        if (locationButton) {
            locationButton.disabled = false;
            locationButton.textContent = "Allow location for delivery";
        }
    }
}

/* ==========================================
   5. CHECKOUT FORM
========================================== */

async function handleDemoCheckout(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const orderMessage = getElement("orderMessage");

    if (!form.reportValidity()) {
        return;
    }

    if (serverCart.items.length === 0) {
        showMessage(orderMessage, "Your cart is empty.", "error");
        return;
    }

    const customerName = getElement("customerName");
    const checkoutData = {
        name: customerName.value.trim(),
        email: getElement("customerEmail").value.trim(),
        address: getElement("customerAddress").value.trim()
    };
    if (currentGpsPosition) {
        checkoutData.latitude = currentGpsPosition.latitude;
        checkoutData.longitude = currentGpsPosition.longitude;
        checkoutData.accuracy = currentGpsPosition.accuracy;
    }

    try {
        const result = await apiRequest("/api/checkout", {
            method: "POST",
            body: JSON.stringify(checkoutData)
        });
        showMessage(
            orderMessage,
            "Demo order #" + result.orderId + " saved. Total: ₹" +
            formatPrice(result.total) + ". No payment was collected and delivery was not arranged by this app.",
            "success"
        );
        currentGpsPosition = null;
        event.currentTarget.reset();
    } catch (error) {
        showMessage(orderMessage, error.message, "error");
    }
}

function addSellerTextRow(container, titleText, detailsText) {
    const row = document.createElement("article");
    row.className = "seller-list-item";
    const title = document.createElement("strong");
    title.textContent = titleText;
    const details = document.createElement("p");
    details.textContent = detailsText;
    row.append(title, details);
    container.appendChild(row);
}

async function loadSellerDashboard() {
    const productList = getElement("sellerProducts");
    const orderList = getElement("sellerOrders");
    if (!productList || !orderList) return;
    productList.replaceChildren();
    orderList.replaceChildren();

    try {
        const [productsResult, ordersResult] = await Promise.all([
            apiRequest("/api/seller/products"),
            apiRequest("/api/seller/orders")
        ]);
        if (productsResult.products.length === 0) {
            addSellerTextRow(productList, "No products listed yet", "Use the form above to add your first product.");
        }
        productsResult.products.forEach(product => {
            addSellerTextRow(
                productList,
                product.name,
                "₹" + formatPrice(product.price) + " · " + product.stock + " in stock"
            );
        });
        if (ordersResult.orders.length === 0) {
            addSellerTextRow(orderList, "No orders yet", "Orders placed for your products will appear here.");
        }
        ordersResult.orders.forEach(order => {
            addSellerTextRow(
                orderList,
                "Order #" + order.orderId + " · ₹" + formatPrice(order.sellerTotal),
                order.items + " · " + order.customerName + " · " + order.customerEmail +
                    " · " + order.address + " · " + order.createdAt
            );
        });
    } catch (error) {
        addSellerTextRow(productList, "Could not load seller dashboard", error.message);
    }
}

async function handleSellerProductSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const message = getElement("sellerProductMessage");
    const product = {
        name: getElement("sellerProductName").value.trim(),
        category: getElement("sellerProductCategory").value,
        price: Number(getElement("sellerProductPrice").value),
        stock: Number(getElement("sellerProductStock").value),
        description: getElement("sellerProductDescription").value.trim(),
        imageUrl: getElement("sellerProductImage").value.trim()
    };
    try {
        await apiRequest("/api/seller/products", {
            method: "POST",
            body: JSON.stringify(product)
        });
        form.reset();
        const bootstrap = await apiRequest("/api/bootstrap");
        renderAdditionalProducts(bootstrap.products);
        filterProducts();
        showMessage(message, "Product listed and now visible in the store.", "success");
        await loadSellerDashboard();
    } catch (error) {
        showMessage(message, error.message, "error");
    }
}


/* ==========================================
   6. LOGIN AND REGISTRATION
========================================== */

async function handleDemoLogin(event) {
    event.preventDefault();

    const form = event.currentTarget;

    if (!form.reportValidity()) {
        return;
    }

    const message = getElement("loginMessage");
    const email = getElement("loginEmail").value.trim();
    const password = getElement("loginPassword").value;

    try {
        await apiRequest("/api/login", {
            method: "POST",
            body: JSON.stringify({ email, password })
        });
        await loadStore();
        form.reset();
        showMessage(message, "Welcome back, " + currentUser.email + ".", "success");
        if (pendingBuyProductId || pendingCheckout) {
            continuePendingPurchase();
        } else {
            window.setTimeout(() => showSection("home"), 700);
        }
    } catch (error) {
        showMessage(message, error.message, "error");
    }
}

async function handleDemoRegister(event) {
    event.preventDefault();

    const form = event.currentTarget;

    if (!form.reportValidity()) {
        return;
    }

    const password = getElement("registerPassword");
    const confirmPassword = getElement("confirmPassword");
    const message = getElement("registerMessage");

    if (
        password &&
        confirmPassword &&
        password.value !== confirmPassword.value
    ) {
        if (message) {
            message.textContent = "Passwords do not match.";
            message.className = "message error";
        } else {
            alert("Passwords do not match.");
        }

        return;
    }

    try {
        await apiRequest("/api/register", {
            method: "POST",
            body: JSON.stringify({
                email: getElement("registerEmail").value.trim(),
                phone: getElement("registerPhone").value.trim(),
                password: password.value
            })
        });
        await loadStore();
        form.reset();
        showMessage(message, "Account created. Welcome, " + currentUser.email + "!", "success");
        if (pendingBuyProductId || pendingCheckout) {
            continuePendingPurchase();
        } else {
            window.setTimeout(() => showSection("home"), 700);
        }
    } catch (error) {
        showMessage(message, error.message, "error");
    }
}

function initializePasswordToggles() {
    document.querySelectorAll("[data-password-toggle]").forEach(button => {
        const passwordInput = getElement(button.dataset.passwordToggle);
        if (!passwordInput) return;

        const setVisibility = visible => {
            passwordInput.type = visible ? "text" : "password";
            button.textContent = visible ? "Hide" : "Show";
            button.setAttribute("aria-pressed", String(visible));
            button.setAttribute(
                "aria-label",
                (visible ? "Hide " : "Show ") +
                    (passwordInput.labels[0]?.textContent.toLowerCase() || "password")
            );
        };

        button.addEventListener("click", () => {
            setVisibility(passwordInput.type === "password");
        });
        passwordInput.form?.addEventListener("reset", () => {
            setVisibility(false);
        });
        setVisibility(false);
    });
}


/* ==========================================
   7. INITIALIZE PAGE
========================================== */

document.addEventListener("DOMContentLoaded", async function () {
    try {
        const bootstrap = await apiRequest("/api/bootstrap");
        renderAdditionalProducts(bootstrap.products);
        serverCart = bootstrap.cart;
        renderDemoCart();
        currentUser = bootstrap.user;
        document.body.classList.toggle("auth-locked", !currentUser);
        updateAccountNavigation();
        showSection(currentUser ? "home" : "login");
    } catch (error) {
        const feedback = getElement("cartFeedback");
        showMessage(
            feedback,
            "Could not load the store: " + error.message,
            "error"
        );
        feedback.hidden = false;
        getElement("productGrid").innerHTML =
            '<p class="products-loading" role="alert">Could not load the store. Start the Python backend with <code>python app.py</code>, then open <code>http://127.0.0.1:8000/</code> and refresh.</p>';
    }

    const searchInput = getElement("searchInput");
    const categoryFilter = getElement("categoryFilter");
    const sortFilter = getElement("sortFilter");
    const searchForm = document.querySelector(".market-search");

    if (searchForm) {
        searchForm.addEventListener("submit", function (event) {
            event.preventDefault();
            filterProducts();
            getElement("products")?.scrollIntoView({
                behavior: "smooth",
                block: "start"
            });
        });
    }

    if (searchInput) {
        searchInput.addEventListener("input", filterProducts);
    }

    document.querySelectorAll("[data-category-link]").forEach(link => {
        link.addEventListener("click", function () {
            if (categoryFilter) {
                categoryFilter.value = link.dataset.categoryLink;
                filterProducts();
            }
        });
    });

    if (categoryFilter) {
        categoryFilter.addEventListener(
            "change",
            filterProducts
        );
    }

    if (sortFilter) {
        sortFilter.addEventListener(
            "change",
            filterProducts
        );
    }

    const checkoutForm = getElement("checkoutForm");
    const locationButton = getElement("useCurrentLocation");

    if (locationButton) {
        locationButton.addEventListener("click", requestCurrentLocation);
    }

    if (checkoutForm) {
        checkoutForm.addEventListener(
            "submit",
            handleDemoCheckout
        );
    }

    const loginForm = getElement("loginForm");

    if (loginForm) {
        loginForm.addEventListener(
            "submit",
            handleDemoLogin
        );
    }

    const registerForm = getElement("registerForm");

    if (registerForm) {
        registerForm.addEventListener(
            "submit",
            handleDemoRegister
        );
    }

    initializePasswordToggles();

    const sellerProductForm = getElement("sellerProductForm");
    if (sellerProductForm) {
        sellerProductForm.addEventListener("submit", handleSellerProductSubmit);
    }

    /*
       Only initialize the local demo cart when the
       standalone demo cart counter exists.
    */

    filterProducts();
});
