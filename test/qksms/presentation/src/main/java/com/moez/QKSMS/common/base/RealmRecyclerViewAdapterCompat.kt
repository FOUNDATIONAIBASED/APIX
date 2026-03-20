/*
 * Copyright (C) 2017 Moez Bhatti <moez.bhatti@gmail.com>
 * Copyright (C) 2025 — minimal RecyclerView bridge for Realm (replaces unavailable io.realm:android-adapters).
 *
 * QKSMS is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
package com.moez.QKSMS.common.base

import androidx.recyclerview.widget.RecyclerView
import io.realm.OrderedRealmCollection
import io.realm.OrderedRealmCollectionChangeListener
import io.realm.RealmList
import io.realm.RealmModel
import io.realm.RealmResults

/**
 * Drop-in subset of the old `io.realm.RealmRecyclerViewAdapter` from `android-adapters`
 * (artifact no longer published). Uses coarse `notifyDataSetChanged()` for updates.
 */
abstract class RealmRecyclerViewAdapterCompat<T : RealmModel, VH : RecyclerView.ViewHolder>(
    private var adapterData: OrderedRealmCollection<T>?,
    private val autoUpdate: Boolean
) : RecyclerView.Adapter<VH>() {

    private var resultsListener: OrderedRealmCollectionChangeListener<RealmResults<T>>? = null
    private var listListener: OrderedRealmCollectionChangeListener<RealmList<T>>? = null

    init {
        addRealmListener()
    }

    fun getData(): OrderedRealmCollection<T>? = adapterData

    open fun getItem(index: Int): T? {
        if (index < 0 || adapterData == null || index >= adapterData!!.size) {
            return null
        }
        return adapterData!![index]
    }

    override fun getItemCount(): Int = adapterData?.size ?: 0

    open fun updateData(data: OrderedRealmCollection<T>?) {
        removeRealmListener()
        adapterData = data
        addRealmListener()
        notifyDataSetChanged()
    }

    private fun addRealmListener() {
        if (adapterData == null || !autoUpdate) return
        when (val d = adapterData) {
            is RealmResults -> {
                val l = OrderedRealmCollectionChangeListener<RealmResults<T>> { _, _ ->
                    notifyDataSetChanged()
                }
                resultsListener = l
                d.addChangeListener(l)
            }
            is RealmList -> {
                val l = OrderedRealmCollectionChangeListener<RealmList<T>> { _, _ ->
                    notifyDataSetChanged()
                }
                listListener = l
                d.addChangeListener(l)
            }
        }
    }

    private fun removeRealmListener() {
        when (val d = adapterData) {
            is RealmResults -> {
                resultsListener?.let { d.removeChangeListener(it) }
                resultsListener = null
            }
            is RealmList -> {
                listListener?.let { d.removeChangeListener(it) }
                listListener = null
            }
        }
    }

    override fun onAttachedToRecyclerView(recyclerView: RecyclerView) {
        super.onAttachedToRecyclerView(recyclerView)
        addRealmListener()
    }

    override fun onDetachedFromRecyclerView(recyclerView: RecyclerView) {
        super.onDetachedFromRecyclerView(recyclerView)
        removeRealmListener()
    }
}
